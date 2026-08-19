// @ts-strict-ignore
import {
  ClockEvents,
  ComponentProps,
  ConsumerSubject,
  DisplayComponent,
  FSComponent,
  MappedSubject,
  Subject,
  SubscribableMapFunctions,
  Subscription,
  VNode,
} from '@microsoft/msfs-sdk';
import { LowerArea } from './LowerArea';
import {
  Arinc429ConsumerSubject,
  Arinc429LocalVarConsumerSubject,
  Arinc429Register,
  Arinc429WordData,
  ArincEventBus,
  FailuresConsumer,
} from '@flybywiresim/fbw-sdk';
import { VerticalTape } from './VerticalTape';

import { AttitudeIndicatorWarnings } from '@flybywiresim/pfd';
import { AttitudeIndicatorWarningsA380 } from './AttitudeIndicatorWarningsA380';
import { LinearDeviationIndicator } from './LinearDeviationIndicator';
import { CdsDisplayUnit, DisplayUnitID } from '../MsfsAvionicsCommon/CdsDisplayUnit';
import { LagFilter } from './PFDUtils';
import { Arinc429Values } from './shared/ArincValueProvider';
import { AltitudeIndicator, AltitudeIndicatorOfftape } from './AltitudeIndicator';
import { AttitudeIndicatorFixedCenter, AttitudeIndicatorFixedUpper } from './AttitudeIndicatorFixed';
import { FMA } from './FMA';
import { HeadingOfftape, HeadingTape } from './HeadingIndicator';
import { Horizon } from './AttitudeIndicatorHorizon';
import { LandingSystem } from './LandingSystemIndicator';
import { AirspeedIndicator, AirspeedIndicatorOfftape, MachNumber } from './SpeedIndicator';
import { VerticalSpeedIndicator } from './VerticalSpeedIndicator';

import './style.scss';
import { PitchTrimDisplay } from './PitchTrimDisplay';
import { PFDSimvars } from './shared/PFDSimvarPublisher';

export const getDisplayIndex = () => {
  const url = Array.from(document.querySelectorAll('vcockpit-panel > *'))
    .find((it) => it.tagName.toLowerCase() !== 'wasm-instrument')
    .getAttribute('url');

  const duId = url ? parseInt(url.substring(url.length - 1), 10) : -1;

  switch (duId) {
    case 0:
      return 1;
    case 3:
      return 2;
    default:
      return 0;
  }
};

interface PFDProps extends ComponentProps {
  bus: ArincEventBus;
  instrument: BaseInstrument;
}

export class PFDComponent extends DisplayComponent<PFDProps> {
  private readonly subscriptions: Subscription[] = [];
  private readonly sub = this.props.bus.getSubscriber<Arinc429Values & ClockEvents & PFDSimvars>();

  private headingFailed = Subject.create(true);

  private displayFailed = Subject.create(false);

  private isAttExcessive = Subject.create(false);

  private pitch: Arinc429WordData = Arinc429Register.empty();

  private roll: Arinc429WordData = Arinc429Register.empty();

  private ownRadioAltitude: Arinc429WordData = Arinc429Register.empty();

  private filteredRadioAltitude = Subject.create(0);

  private radioAltitudeFilter = new LagFilter(5);

  private failuresConsumer: FailuresConsumer;

  private readonly groundSpeed = Arinc429LocalVarConsumerSubject.create(this.sub.on('groundSpeed'), 0);

  private readonly spoilersArmed = ConsumerSubject.create(this.sub.on('spoilersArmed'), false);

  private readonly thrustTla = [
    ConsumerSubject.create(this.sub.on('tla1'), 0),
    ConsumerSubject.create(this.sub.on('tla2'), 0),
    ConsumerSubject.create(this.sub.on('tla3'), 0),
    ConsumerSubject.create(this.sub.on('tla4'), 0),
  ];
  private readonly atLeastThreeThrustLeversOutOfIdle = MappedSubject.create(
    ([t1, t2, t3, t4]) => [t1, t2, t3, t4].filter((t) => t > 5).length > 2,
    ...this.thrustTla,
  );

  private readonly leftMainGearCompressed = ConsumerSubject.create(this.sub.on('leftMainGearCompressed'), false);
  private readonly rightMainGearCompressed = ConsumerSubject.create(this.sub.on('rightMainGearCompressed'), false);
  private readonly eitherMainLgCompressed = MappedSubject.create(
    SubscribableMapFunctions.or(),
    this.leftMainGearCompressed,
    this.rightMainGearCompressed,
  );

  private previousFlapHandlePosition = 0;

  private readonly pitchTrimIndicatorVisible = Subject.create(false);

  // Tape scroll state lives here because the graduation layers are siblings of the main SVG,
  // while the tape overlays (bugs, bars, readouts) stay inside it. Both scroll off the same value.
  private readonly speedTapeValue = Subject.create(0);

  private readonly speedTapeVisible = this.speedTapeValue.map((v) => !Number.isNaN(v));

  private readonly altitudeWord = Arinc429ConsumerSubject.create(
    this.props.bus.getArincSubscriber<Arinc429Values>().on('altitudeAr'),
  );

  private readonly altitudeTapeValue = this.altitudeWord.map((v) => v.value);

  private readonly altitudeTapeVisible = this.altitudeWord.map((v) => v.isNormalOperation() || v.isFunctionalTest());

  private updatePitchTrimVisible(flapsRetracted = false) {
    const gs = this.groundSpeed.get().valueOr(0);
    if (this.filteredRadioAltitude.get() > 50) {
      this.pitchTrimIndicatorVisible.set(false);
    } else if (gs < 30) {
      this.pitchTrimIndicatorVisible.set(true);
    } else if (
      this.eitherMainLgCompressed.get() &&
      gs > 80 &&
      (this.spoilersArmed.get() === false || flapsRetracted === true || this.atLeastThreeThrustLeversOutOfIdle.get())
    ) {
      // FIXME add "flight crew presses pitch trim switches"
      this.pitchTrimIndicatorVisible.set(true);
    }
  }

  constructor(props: PFDProps) {
    super(props);
    this.failuresConsumer = new FailuresConsumer();
  }

  public onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.subscriptions.push(
      this.sub.on('headingAr').handle((h) => {
        if (this.headingFailed.get() !== h.isNormalOperation()) {
          this.headingFailed.set(!h.isNormalOperation());
        }
      }),
    );

    this.subscriptions.push(
      this.sub.on('rollAr').handle((r) => {
        this.roll = r;
      }),
    );

    this.subscriptions.push(
      this.sub.on('pitchAr').handle((p) => {
        this.pitch = p;
      }),
    );

    this.subscriptions.push(
      this.sub
        .on('realTime')
        .atFrequency(1)
        .handle((_t) => {
          this.failuresConsumer.update();
          if (
            !this.isAttExcessive.get() &&
            ((this.pitch.isNormalOperation() && (this.pitch.value > 25 || this.pitch.value < -13)) ||
              (this.roll.isNormalOperation() && Math.abs(this.roll.value) > 45))
          ) {
            this.isAttExcessive.set(true);
          } else if (
            this.isAttExcessive.get() &&
            this.pitch.isNormalOperation() &&
            this.pitch.value < 22 &&
            this.pitch.value > -10 &&
            this.roll.isNormalOperation() &&
            Math.abs(this.roll.value) < 40
          ) {
            this.isAttExcessive.set(false);
          }
        }),
    );

    this.subscriptions.push(
      this.sub.on('chosenRa').handle((ra) => {
        this.ownRadioAltitude = ra;
        const filteredRadioAltitude = this.radioAltitudeFilter.step(
          this.ownRadioAltitude.value,
          this.props.instrument.deltaTime / 1000,
        );
        this.filteredRadioAltitude.set(filteredRadioAltitude);
        this.updatePitchTrimVisible();
      }),
    );

    this.subscriptions.push(
      this.sub
        .on('flapHandleIndex')
        .whenChanged()
        .handle((fh) => {
          if (this.previousFlapHandlePosition > fh) {
            this.updatePitchTrimVisible(true);
          }
          this.previousFlapHandlePosition = fh;
        }),
    );

    this.subscriptions.push(
      this.groundSpeed.sub(() => this.updatePitchTrimVisible()),
      this.spoilersArmed.sub(() => this.updatePitchTrimVisible()),
      this.atLeastThreeThrustLeversOutOfIdle.sub(() => this.updatePitchTrimVisible()),
      this.groundSpeed,
      this.spoilersArmed,
      this.leftMainGearCompressed,
      this.rightMainGearCompressed,
      this.eitherMainLgCompressed,
      this.atLeastThreeThrustLeversOutOfIdle,
    );

    for (const s of this.thrustTla) {
      this.subscriptions.push(s);
    }
  }

  render(): VNode {
    return (
      <CdsDisplayUnit
        bus={this.props.bus}
        displayUnitId={getDisplayIndex() === 1 ? DisplayUnitID.CaptPfd : DisplayUnitID.FoPfd}
        test={Subject.create(-1)}
        failed={Subject.create(false)}
      >
        {/* The display background is its own element because the SVG below no longer covers the
            whole screen, and the HTML layers are transparent. */}
        <div class="pfd-background" />
        {/* Tape graduations are their own layers, under the main SVG: scrolling them there only
            repaints the window-sized clip region instead of re-recording every tick and label in
            the SVG. Mask2 leaves the tape windows transparent, so the overlays in the SVG still
            paint on top. Windows match Mask2's cut-outs, which are wider than the grey backgrounds
            so that the tick stroke caps are not clipped. */}
        <VerticalTape
          type="speed"
          tapeValue={this.speedTapeValue}
          visible={this.speedTapeVisible}
          lowerLimit={30}
          upperLimit={660}
          valueSpacing={10}
          displayRange={48}
          distanceSpacing={10}
          window={{ x: 1.9058, y: 38.087, width: 27.548, height: 85.473 }}
          background={{ x: 1.9058, y: 38.087, width: 17.125, height: 85.473 }}
        />
        <VerticalTape
          type="altitude"
          tapeValue={this.altitudeTapeValue}
          visible={this.altitudeTapeVisible}
          lowerLimit={-1500}
          upperLimit={50000}
          valueSpacing={100}
          displayRange={630}
          distanceSpacing={7.5}
          window={{ x: 115.14, y: 38.087, width: 20.344, height: 85.473 }}
          background={{ x: 117.754, y: 38.087, width: 13.096, height: 85.473 }}
        />
        {/* Sized to the band its content actually occupies (viewBox y 22.4 to 158): the FMA above
            and the lower area below are separate layers now, so anything outside this band would
            only be empty surface that Coherent still has to rasterize on every attitude/tape
            update. Child coordinates are unchanged — only the viewport is sliced. */}
        <svg
          class="pfd-svg"
          version="1.1"
          viewBox="0 22.4 158.75 135.6"
          xmlns="http://www.w3.org/2000/svg"
          xmlnsXlink="http://www.w3.org/1999/xlink"
        >
          <defs>
            {/* The attitude aperture (same curve as Mask1's first subpath). The horizon group is
                clipped to it because Mask1 now has transparent holes over the tape windows (the
                tape graduations are HTML layers UNDER this svg) — without the clip, the horizon's
                sky/earth overflow would bleed through those holes. */}
            <clipPath id="PfdAttitudeAperture">
              {/* eslint-disable-next-line max-len */}
              <path d="m 32.138 101.25 c 7.4164 13.363 21.492 21.652 36.768 21.652 c 15.277 0 29.352 -8.2886 36.768 -21.652 v -40.859 c -7.4164 -13.363 -21.492 -21.652 -36.768 -21.652 c -15.277 0 -29.352 8.2886 -36.768 21.652 z" />
            </clipPath>
          </defs>
          <g clip-path="url(#PfdAttitudeAperture)">
            <Horizon
              bus={this.props.bus}
              instrument={this.props.instrument}
              isAttExcessive={this.isAttExcessive}
              filteredRadioAlt={this.filteredRadioAltitude}
            />
            <AttitudeIndicatorFixedCenter bus={this.props.bus} isAttExcessive={this.isAttExcessive} />
          </g>
          <path
            id="Mask1"
            class="BackgroundFill"
            // Same as before, plus the two tape-window holes Mask2 has, so the HTML tape layers
            // underneath this svg stay visible.
            // eslint-disable-next-line max-len
            d="m 32.138 101.25 c 7.4164 13.363 21.492 21.652 36.768 21.652 c 15.277 0 29.352 -8.2886 36.768 -21.652 v -40.859 c -7.4164 -13.363 -21.492 -21.652 -36.768 -21.652 c -15.277 0 -29.352 8.2886 -36.768 21.652 z m -32.046 110.498 h 158.66 v -211.75 h -158.66 z m 115.14 -88.191 v -85.473 h 20.344 v 85.473 z m -113.33 0 v -85.473 h 27.548 v 85.473 z"
          />
          <HeadingTape bus={this.props.bus} failed={this.headingFailed} />
          <AltitudeIndicator bus={this.props.bus} />
          <AirspeedIndicator bus={this.props.bus} instrument={this.props.instrument} tapeValue={this.speedTapeValue} />
          <path
            id="Mask2"
            class="BackgroundFill"
            // eslint-disable-next-line max-len
            d="m 32.138 145.34 h 73.536 v 10.382 h -73.536 z m 0 -44.092 c 7.4164 13.363 21.492 21.652 36.768 21.652 c 15.277 0 29.352 -8.2886 36.768 -21.652 v -40.859 c -7.4164 -13.363 -21.492 -21.652 -36.768 -21.652 c -15.277 0 -29.352 8.2886 -36.768 21.652 z m -32.046 110.498 h 158.66 v -211.746 h -158.66 z m 115.14 -88.191 v -85.473 h 20.344 v 85.473 z m -113.33 0 v -85.473 h 27.548 v 85.473 z"
          />
          <AirspeedIndicatorOfftape bus={this.props.bus} />

          <LandingSystem bus={this.props.bus} instrument={this.props.instrument} />
          <AttitudeIndicatorFixedUpper bus={this.props.bus} />
          <AttitudeIndicatorWarnings bus={this.props.bus} instrument={this.props.instrument} />
          <AttitudeIndicatorWarningsA380 bus={this.props.bus} instrument={this.props.instrument} />
          <VerticalSpeedIndicator
            bus={this.props.bus}
            instrument={this.props.instrument}
            filteredRadioAltitude={this.filteredRadioAltitude}
          />
          <HeadingOfftape bus={this.props.bus} failed={this.headingFailed} />
          <AltitudeIndicatorOfftape bus={this.props.bus} filteredRadioAltitude={this.filteredRadioAltitude} />
          <LinearDeviationIndicator bus={this.props.bus} />
        </svg>
        <div class="pfd-mach-layer">
          <MachNumber bus={this.props.bus} />
        </div>
        {/* The FMA and the lower area are separate SVG layers on purpose: Coherent dirties and
            redraws per SVG element, so keeping the change-driven strips out of the main SVG stops
            the per-frame attitude/tape updates from repainting them (and vice versa). Both layers
            use a viewBox slice of the main coordinate system, so child coordinates are unchanged. */}
        <div class="pfd-fma-layer">
          <FMA bus={this.props.bus} isAttExcessive={this.isAttExcessive} />
        </div>
        <svg
          class="pfd-lower-area-layer"
          version="1.1"
          viewBox="0 156 158.75 55.6"
          xmlns="http://www.w3.org/2000/svg"
          xmlnsXlink="http://www.w3.org/1999/xlink"
        >
          <LowerArea bus={this.props.bus} pitchTrimIndicatorVisible={this.pitchTrimIndicatorVisible} />
        </svg>
        <PitchTrimDisplay bus={this.props.bus} visible={this.pitchTrimIndicatorVisible} />
      </CdsDisplayUnit>
    );
  }

  destroy(): void {
    for (const s of this.subscriptions) {
      s.destroy();
    }

    super.destroy();
  }
}
