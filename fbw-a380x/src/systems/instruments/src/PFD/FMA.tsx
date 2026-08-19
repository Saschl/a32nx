/* eslint-disable no-dupe-else-if */
/* eslint-disable no-constant-condition */
import {
  ComponentProps,
  ConsumerSubject,
  DisplayComponent,
  EventBus,
  FSComponent,
  MappedSubject,
  Subject,
  Subscribable,
  SubscribableMapFunctions,
  VNode,
} from '@microsoft/msfs-sdk';
import { Arinc429Values } from './shared/ArincValueProvider';
import { PFDSimvars } from './shared/PFDSimvarPublisher';
import { Arinc429ConsumerSubject, Arinc429LocalVarConsumerSubject, ArincEventBus } from '@flybywiresim/fbw-sdk';
import { DmcLogicEvents } from '../MsfsAvionicsCommon/providers/DmcPublisher';
import { PrimFgBusBaseEvents } from '@shared/publishers/PrimFgPublisher';
import { FlashOneHertz } from '../MsfsAvionicsCommon/FlashingElementUtils';
import {
  A1A2Messages,
  A3Messages,
  B1Messages,
  BC3Messages,
  C1Messages,
  computeA1A2Message,
  computeA3Message,
  computeB1Message,
  computeBC3Message,
  computeC1Message,
  computeD1D2Message,
  D1D2Messages,
} from './FMADefinitions';
import { FcdcBusBaseEvents } from '@shared/publishers/FcdcPublisher';
import { FcuEfisCpBusEvents } from '../../../shared/src/publishers/EfisCpBusPublisher';
import { getDisplayIndex } from './PFD';

// The FMA is rendered as an HTML layer (not SVG): all cells are pure text and outline boxes, and
// keeping them out of the main SVG means neither mode changes nor per-frame tape/attitude redraws
// dirty each other. Coordinates stay in the PFD's 158.75-unit system and are converted to CSS
// pixels with the same uniform scale the main SVG renders at.
const FMA_PX_PER_UNIT = 768 / 158.75;

const px = (units: number) => Math.round(units * FMA_PX_PER_UNIT * 100) / 100;

/** Row bands (top edge / common height), taken from the original mode-change box geometry. */
const ROW_1_TOP = 1.8143;
const ROW_2_TOP = 9.0715;
const ROW_3_TOP = 16.329;
const ROW_HEIGHT = 6.0476;

/** Equivalent of the SVG 0.16mm NormalStroke at display scale. */
const BOX_BORDER = '2.9px solid';

/**
 * Style for a text span vertically centered in a row band, horizontally anchored at x
 * (mirrors the SVG text-anchor semantics).
 */
const textStyle = (x: number, rowTop: number, anchor: 'middle' | 'start' | 'end' = 'middle') =>
  `position: absolute; left: ${px(x)}px; top: ${px(rowTop)}px; height: ${px(ROW_HEIGHT)}px; ` +
  `display: flex; align-items: center; white-space: pre;` +
  (anchor === 'middle' ? ' transform: translateX(-50%);' : anchor === 'end' ? ' transform: translateX(-100%);' : '');

/** Style for an outline box (replaces the SVG rectangle paths). Border color comes from the class. */
const boxStyle = (x: number, y: number, w: number, h: number) =>
  `position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; ` +
  `border: ${BOX_BORDER}; box-sizing: border-box;`;

abstract class ShowForSecondsComponent<T extends ComponentProps> extends DisplayComponent<T> {
  private timeout: number = 0;

  private readonly displayTimeInSeconds: number;

  protected modeChangedPathRef = FSComponent.createRef<HTMLDivElement>();

  protected isShown = false;

  protected constructor(props: T, displayTimeInSeconds: number) {
    super(props);
    this.displayTimeInSeconds = displayTimeInSeconds;
  }

  public displayModeChangedPath = (cancel = false) => {
    if (cancel || !this.isShown) {
      clearTimeout(this.timeout);
      this.modeChangedPathRef.instance.classList.remove('ModeChangedPath');
    } else {
      this.modeChangedPathRef.instance.classList.add('ModeChangedPath');
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.modeChangedPathRef.instance.classList.remove('ModeChangedPath');
      }, this.displayTimeInSeconds * 1000) as unknown as number;
    }
  };
}

export class FMA extends DisplayComponent<{
  readonly bus: ArincEventBus;
  readonly isAttExcessive: Subscribable<boolean>;
}> {
  private sub = this.props.bus.getSubscriber<
    PFDSimvars & Arinc429Values & DmcLogicEvents & PrimFgBusBaseEvents & FcdcBusBaseEvents
  >();

  private primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private primFgDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_2'));

  private primFgDiscreteWord3 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_3'));

  private primFgDiscreteWord4 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_4'));

  private primFgDiscreteWord6 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_6'));

  private primFgAtsDiscreteWord = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_ats_discrete_word'));

  private primFgAtsFmaDiscreteWord = Arinc429LocalVarConsumerSubject.create(
    this.sub.on('prim_fg_ats_fma_discrete_word'),
  );

  private readonly fcdcDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('fcdc_discrete_word_1'));

  private readonly ap1Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(11, false));

  private readonly ap2Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(12, false));

  private readonly athrEngaged = this.primFgAtsDiscreteWord.map((word) => word.bitValueOr(11, false));

  private readonly athrActive = this.primFgAtsDiscreteWord.map((word) => word.bitValueOr(12, false));

  private machPresel = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_presel_mach'));

  private speedPresel = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_presel_speed'));

  private setHoldSpeed = ConsumerSubject.create(this.sub.on('setHoldSpeed'), false);

  private tdReached = ConsumerSubject.create(this.sub.on('tdReached'), false);

  private firstBorderRef = FSComponent.createRef<HTMLDivElement>();

  private secondBorderRef = FSComponent.createRef<HTMLDivElement>();

  private readonly altitude = Arinc429ConsumerSubject.create(
    this.props.bus.getArincSubscriber<Arinc429Values>().on('altitudeAr'),
  );

  // Arinc429ConsumerSubject (value+ssm equality): the provider re-publishes the same mutated
  // register reference, so a default-equality ConsumerSubject would never notify again
  private readonly landingElevation = Arinc429ConsumerSubject.create(this.sub.on('landingElevation'));

  private readonly radioHeight = Arinc429ConsumerSubject.create(this.sub.on('chosenRa'));

  private readonly fwcFlightPhase = ConsumerSubject.create(this.sub.on('fwcFlightPhase'), 0);

  private readonly btvExitMissed = ConsumerSubject.create(this.sub.on('btvExitMissed'), false);

  private readonly autoBrakeActive = ConsumerSubject.create(this.sub.on('autoBrakeActive'), false);

  private readonly autoBrakeMode = ConsumerSubject.create(this.sub.on('autoBrakeMode'), 0);

  private readonly B1Message = this.primFgDiscreteWord3.map((primFgDiscreteWord3) =>
    computeB1Message(primFgDiscreteWord3),
  );

  private readonly disconnectApForLdg = MappedSubject.create(
    ([ap1, ap2, ra, altitude, landingElevation, B1Message]) => {
      return (
        (ap1 || ap2) &&
        (ra.isNormalOperation() ? ra.value <= 150 : altitude.valueOr(Infinity) - landingElevation.valueOr(0) <= 150) &&
        (B1Message === B1Messages.DES ||
          B1Message === B1Messages.OP_DES ||
          B1Message === B1Messages.FPA ||
          B1Message === B1Messages.VS ||
          B1Message === B1Messages.APP_DES)
      );
    },
    this.ap1Engaged,
    this.ap2Engaged,
    this.radioHeight,
    this.altitude,
    this.landingElevation,
    this.B1Message,
  );

  private readonly BC3Message = MappedSubject.create(
    ([
      isAttExcessive,
      primFgDiscreteWord2,
      setHoldSpeed,
      fcdcDiscreteWord1,
      fwcFlightPhase,
      primFgDiscreteWord6,
      tdReached,
      disconnectApForLdg,
      btvExitMissed,
    ]) => {
      return computeBC3Message(
        isAttExcessive,
        setHoldSpeed,
        fcdcDiscreteWord1,
        fwcFlightPhase,
        tdReached,
        disconnectApForLdg,
        btvExitMissed,
        primFgDiscreteWord2,
        primFgDiscreteWord6,
      );
    },
    this.props.isAttExcessive,
    this.primFgDiscreteWord2,
    this.setHoldSpeed,
    this.fcdcDiscreteWord1,
    this.fwcFlightPhase,
    this.primFgDiscreteWord6,
    this.tdReached,
    this.disconnectApForLdg,
    this.btvExitMissed,
  );

  private readonly A1A2Message = MappedSubject.create(
    ([athrEngaged, athrActive, primFgAtsFmaDiscreteWord, autoBrakeActive, autoBrakeMode]) => {
      return computeA1A2Message(athrEngaged, athrActive, primFgAtsFmaDiscreteWord, autoBrakeActive, autoBrakeMode);
    },
    this.athrEngaged,
    this.athrActive,
    this.primFgAtsFmaDiscreteWord,
    this.autoBrakeActive,
    this.autoBrakeMode,
  );

  private readonly A3Message = MappedSubject.create(
    ([primFgAtsFmaDiscreteWord, autoBrakeActive, autoBrakeMode]) => {
      return computeA3Message(primFgAtsFmaDiscreteWord, false, autoBrakeActive, autoBrakeMode);
    },
    this.primFgAtsFmaDiscreteWord,
    this.autoBrakeActive,
    this.autoBrakeMode,
  );

  private readonly sharedModeActive = MappedSubject.create(
    ([primFgDiscreteWord1, primFgDiscreteWord3, primFgDiscreteWord4]) => {
      const rollOutActive = primFgDiscreteWord4.bitValueOr(26, false);
      const flareActive = primFgDiscreteWord3.bitValueOr(24, false);
      const landActive = primFgDiscreteWord1.bitValueOr(23, false);

      return landActive || rollOutActive || flareActive;
    },
    this.primFgDiscreteWord1,
    this.primFgDiscreteWord3,
    this.primFgDiscreteWord4,
  );

  private handleFMABorders() {
    const sharedModeActive = this.sharedModeActive.get();
    const BC3Message = this.BC3Message.get() !== 0;

    const engineMessage = this.A3Message.get();
    const AB3Message =
      (this.machPresel.get().isNormalOperation() || this.speedPresel.get().isNormalOperation()) &&
      !BC3Message &&
      engineMessage === A3Messages.NONE;
    let secondBorder: number;
    if (sharedModeActive && !this.props.isAttExcessive.get()) {
      secondBorder = 0;
    } else if (BC3Message) {
      secondBorder = 15.766;
    } else {
      secondBorder = 20.864;
    }

    let firstBorder: number;
    if (AB3Message && !this.props.isAttExcessive.get()) {
      firstBorder = 15.766;
    } else {
      firstBorder = 20.864;
    }

    this.firstBorderRef.instance.style.height = `${px(firstBorder)}px`;
    this.secondBorderRef.instance.style.height = `${px(secondBorder)}px`;
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.BC3Message.sub(() => {
      this.handleFMABorders();
    }, true);

    this.sharedModeActive.sub(() => {
      this.handleFMABorders();
    }, true);

    this.A3Message.sub(() => {
      this.handleFMABorders();
    }, true);

    this.machPresel.sub(() => {
      this.handleFMABorders();
    }, true);

    this.speedPresel.sub(() => {
      this.handleFMABorders();
    }, true);
  }

  render(): VNode {
    return (
      <div id="FMA" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;">
        <div ref={this.firstBorderRef} class="FmaSeparator" style={`left: ${px(33.117) - 1.45}px;`} />
        <div ref={this.secondBorderRef} class="FmaSeparator" style={`left: ${px(66.241) - 1.45}px;`} />
        <div class="FmaSeparator" style={`left: ${px(102.52) - 1.45}px; height: ${px(20.864)}px;`} />
        <div class="FmaSeparator" style={`left: ${px(133.72) - 1.45}px; height: ${px(20.864)}px;`} />

        <Row1
          bus={this.props.bus}
          isAttExcessive={this.props.isAttExcessive}
          A1A2CellMessage={this.A1A2Message}
          B1CellMessage={this.B1Message}
        />
        <Row2 bus={this.props.bus} isAttExcessive={this.props.isAttExcessive} A1A2CellMessage={this.A1A2Message} />
        <Row3
          bus={this.props.bus}
          isAttExcessive={this.props.isAttExcessive}
          BC3Message={this.BC3Message}
          A3Message={this.A3Message}
        />
      </div>
    );
  }
}

class Row1 extends DisplayComponent<{
  readonly bus: EventBus;
  readonly isAttExcessive: Subscribable<boolean>;
  readonly A1A2CellMessage: Subscribable<number>;
  readonly B1CellMessage: Subscribable<number>;
}> {
  private b1Cell = FSComponent.createRef<B1Cell>();

  private c1Cell = FSComponent.createRef<C1Cell>();

  private D1D2Cell = FSComponent.createRef<D1D2Cell>();

  private BC1Cell = FSComponent.createRef<BC1Cell>();

  private cellsToHide = FSComponent.createRef<HTMLDivElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.isAttExcessive.sub((a) => {
      if (a) {
        this.cellsToHide.instance.style.display = 'none';
        this.b1Cell.instance.displayModeChangedPath(true);
        this.c1Cell.instance.displayModeChangedPath(true);
        this.BC1Cell.instance.displayModeChangedPath(true);
      } else {
        this.cellsToHide.instance.style.display = 'block';
        this.b1Cell.instance.displayModeChangedPath();
        this.c1Cell.instance.displayModeChangedPath();
        this.BC1Cell.instance.displayModeChangedPath();
      }
    });
  }

  render(): VNode {
    return (
      <div>
        <A1A2Cell bus={this.props.bus} A1A2CellMessage={this.props.A1A2CellMessage} />

        <div ref={this.cellsToHide}>
          <B1Cell ref={this.b1Cell} bus={this.props.bus} B1Message={this.props.B1CellMessage} />
          <C1Cell ref={this.c1Cell} bus={this.props.bus} />
          <D1D2Cell ref={this.D1D2Cell} bus={this.props.bus} />
          <BC1Cell ref={this.BC1Cell} bus={this.props.bus} />
        </div>
        <E1Cell bus={this.props.bus} />
      </div>
    );
  }
}

class Row2 extends DisplayComponent<{
  bus: EventBus;
  isAttExcessive: Subscribable<boolean>;
  A1A2CellMessage: Subscribable<number>;
}> {
  private cellsToHide = FSComponent.createRef<HTMLDivElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.isAttExcessive.sub((a) => {
      if (a) {
        this.cellsToHide.instance.style.display = 'none';
      } else {
        this.cellsToHide.instance.style.display = 'block';
      }
    });
  }

  render(): VNode {
    return (
      <div>
        <A2Cell bus={this.props.bus} A1A2CellMessage={this.props.A1A2CellMessage} />
        <div ref={this.cellsToHide}>
          <B2Cell bus={this.props.bus} />
          <C2Cell bus={this.props.bus} />
        </div>
        <E2Cell bus={this.props.bus} />
      </div>
    );
  }
}

class A2Cell extends DisplayComponent<{ bus: EventBus; A1A2CellMessage: Subscribable<A1A2Messages> }> {
  private text = Subject.create('');

  private className = Subject.create('FontMediumSmaller Cyan');

  private autoBrkRef = FSComponent.createRef<HTMLSpanElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    sub
      .on('autoBrakeMode')
      .whenChanged()
      .handle((am) => {
        switch (am) {
          case 0:
            this.text.set('');
            break;
          case 1:
            this.text.set('BTV ');
            break;
          case 2:
            this.text.set('BRK LO ');
            break;
          case 3:
            this.text.set('BRK 2 ');
            break;
          case 4:
            this.text.set('BRK 3 ');
            break;
          case 5:
            this.text.set('BRK HI ');
            break;
          default:
            this.text.set('');
            break;
        }
      });

    sub
      .on('autoBrakeActive')
      .whenChanged()
      .handle((am) => {
        if (am) {
          this.autoBrkRef.instance.style.visibility = 'hidden';
        } else {
          this.autoBrkRef.instance.style.visibility = 'visible';
        }
      });

    this.props.A1A2CellMessage.sub((message) => {
      // ATHR mode overrides BRK LO and MED memo
      if (message > A1A2Messages.NONE && message <= A1A2Messages.MAN_THR) {
        this.autoBrkRef.instance.style.visibility = 'hidden';
      } else {
        this.autoBrkRef.instance.style.visibility = 'visible';
      }
    }, true);
  }

  render(): VNode {
    return (
      <span ref={this.autoBrkRef} class={this.className} style={textStyle(16.782249, ROW_2_TOP)}>
        {this.text}
      </span>
    );
  }
}

class Row3 extends DisplayComponent<{
  readonly bus: ArincEventBus;
  readonly isAttExcessive: Subscribable<boolean>;
  readonly BC3Message: Subscribable<BC3Messages>;
  readonly A3Message: Subscribable<A3Messages>;
}> {
  private cellsToHide = FSComponent.createRef<HTMLDivElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.isAttExcessive.sub((a) => {
      if (a) {
        this.cellsToHide.instance.style.display = 'none';
      } else {
        this.cellsToHide.instance.style.display = 'block';
      }
    });
  }

  render(): VNode {
    return (
      <div>
        <A3Cell bus={this.props.bus} A3Message={this.props.A3Message} />
        <div ref={this.cellsToHide}>
          <AB3Cell bus={this.props.bus} A3Message={this.props.A3Message} />
          <D3Cell bus={this.props.bus} />
        </div>
        <BC3Cell BC3Message={this.props.BC3Message} />
        <E3Cell bus={this.props.bus} />
      </div>
    );
  }
}

interface CellProps extends ComponentProps {
  bus: EventBus;
}

interface A1A2CellProps extends CellProps {
  A1A2CellMessage: Subscribable<A1A2Messages>;
}

class A1A2Cell extends ShowForSecondsComponent<A1A2CellProps> {
  private readonly sub = this.props.bus.getSubscriber<PFDSimvars>();

  private flexTemp = ConsumerSubject.create(this.sub.on('flexTemp'), 0);

  private readonly msgBoxRef = FSComponent.createRef<HTMLDivElement>();

  private readonly line1Ref = FSComponent.createRef<HTMLSpanElement>();

  private readonly line2Ref = FSComponent.createRef<HTMLSpanElement>();

  private readonly flxPlusRef = FSComponent.createRef<HTMLSpanElement>();

  private readonly flxTempRef = FSComponent.createRef<HTMLSpanElement>();

  constructor(props: A1A2CellProps) {
    super(props, 10);
  }

  private setText() {
    this.isShown = true;

    let line1 = '';
    let line1Class = 'FontMedium Green';
    let line1X = 16.782249;
    let line2: string | null = null;
    let line2X = 16.869141;
    let flxTemp: string | null = null;
    let boxShown = false;
    let boxX = 0;
    let boxW = 0;
    let boxH = 13.506;
    let boxClass = 'White';

    switch (this.props.A1A2CellMessage.get()) {
      case A1A2Messages.MAN_TOGA:
        this.displayModeChangedPath(true);
        line1 = 'MAN';
        line1Class = 'FontMedium White';
        line1X = 17.052249;
        line2 = 'TOGA';
        boxShown = true;
        boxX = 8.162;
        boxW = 16.952;
        break;
      case A1A2Messages.MAN_GA_SOFT:
        this.displayModeChangedPath(true);
        line1 = 'MAN';
        line1Class = 'FontMedium White';
        line1X = 17.052249;
        line2 = 'GA SOFT';
        boxShown = true;
        boxX = 1.304;
        boxW = 30.217;
        break;
      case A1A2Messages.MAN_FLEX:
        this.displayModeChangedPath(true);
        line1 = 'MAN';
        line1Class = 'FontMedium White';
        line1X = 17.052249;
        line2 = 'FLX';
        line2X = 11.669141;
        flxTemp = Math.round(this.flexTemp.get()).toString();
        boxShown = true;
        boxX = 5.304;
        boxW = 24.517;
        break;
      case A1A2Messages.MAN_MCT:
        this.displayModeChangedPath(true);
        line1 = 'MAN';
        line1Class = 'FontMedium White';
        line1X = 17.052249;
        line2 = 'MCT';
        boxShown = true;
        boxX = 8.162;
        boxW = 16.952;
        break;
      case A1A2Messages.MAN_THR:
        this.displayModeChangedPath(true);
        line1 = 'MAN';
        line1Class = 'FontMedium White';
        line1X = 17.052249;
        line2 = 'THR';
        boxShown = true;
        boxX = 8.162;
        boxW = 16.952;
        boxClass = 'Amber';
        break;
      case A1A2Messages.SPEED:
        line1 = 'SPEED';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.MACH:
        line1 = 'MACH';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.THR_MCT:
        line1 = 'THR MCT';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.THR_CLB:
        line1 = 'THR CLB';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.THR_LVR:
        line1 = 'THR LVR';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.THR_IDLE:
        line1 = 'THR IDLE';
        line1Class = 'FontMediumSmaller Green';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.A_FLOOR:
        this.displayModeChangedPath(true);
        line1 = 'A.FLOOR';
        boxShown = true;
        boxX = 0.70556;
        boxW = 30.927;
        boxH = ROW_HEIGHT;
        boxClass = 'Amber BlinkInfinite';
        break;
      case A1A2Messages.TOGA_LK:
        this.displayModeChangedPath(true);
        line1 = 'TOGA LK';
        boxShown = true;
        boxX = 0.70556;
        boxW = 30.927;
        boxH = ROW_HEIGHT;
        boxClass = 'Amber BlinkInfinite';
        break;
      case A1A2Messages.BTV:
        line1 = 'BTV';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.BRK_LO:
        line1 = 'BRK LO';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.BRK_2:
        line1 = 'BRK 2 ';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.BRK_3:
        line1 = 'BRK 3 ';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.BRK_HI:
        line1 = 'BRK HI ';
        this.displayModeChangedPath();
        break;
      case A1A2Messages.BRK_RTO:
        line1 = 'BRK RTO';
        this.displayModeChangedPath();
        break;
      default:
        line1 = '';
        this.isShown = false;
        this.displayModeChangedPath(true);
    }

    const line1El = this.line1Ref.instance;
    line1El.textContent = line1;
    line1El.className = line1Class;
    line1El.style.left = `${px(line1X)}px`;

    const line2El = this.line2Ref.instance;
    if (line2 !== null) {
      line2El.textContent = line2;
      line2El.style.left = `${px(line2X)}px`;
      line2El.style.display = 'flex';
    } else {
      line2El.style.display = 'none';
    }

    const flxDisplay = flxTemp !== null ? 'flex' : 'none';
    this.flxPlusRef.instance.style.display = flxDisplay;
    this.flxTempRef.instance.style.display = flxDisplay;
    if (flxTemp !== null) {
      this.flxTempRef.instance.textContent = flxTemp;
    }

    const boxEl = this.msgBoxRef.instance;
    if (boxShown) {
      boxEl.style.left = `${px(boxX)}px`;
      boxEl.style.width = `${px(boxW)}px`;
      boxEl.style.height = `${px(boxH)}px`;
      boxEl.className = boxClass;
      boxEl.style.display = 'block';
    } else {
      boxEl.style.display = 'none';
    }
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.A1A2CellMessage.sub(() => {
      this.setText();
    }, true);

    this.flexTemp.sub(() => {
      this.setText();
    }, true);
  }

  render(): VNode {
    return (
      <>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(3.3, ROW_1_TOP, 27.127, ROW_HEIGHT)} visibility: hidden;`}
        />
        <div ref={this.msgBoxRef} style={`${boxStyle(0, ROW_1_TOP, 1, ROW_HEIGHT)} display: none;`} />
        <span ref={this.line1Ref} style={textStyle(16.782249, ROW_1_TOP)} />
        <span
          ref={this.line2Ref}
          class="FontMedium White"
          style={`${textStyle(16.869141, ROW_2_TOP)} display: none;`}
        />
        <span ref={this.flxPlusRef} class="FontMedium Cyan" style={`${textStyle(20.599141, ROW_2_TOP)} display: none;`}>
          +
        </span>
        <span
          ref={this.flxTempRef}
          class="FontMedium Cyan"
          style={`${textStyle(26.099141, ROW_2_TOP)} display: none;`}
        />
      </>
    );
  }
}

interface A3CellProps extends CellProps {
  A3Message: Subscribable<A3Messages>;
}

class A3Cell extends DisplayComponent<A3CellProps> {
  private classSub = Subject.create('');

  private textSub = Subject.create('');

  private onUpdateAthrModeMessage(message: A3Messages) {
    let text: string = '';
    let className: string = '';
    switch (message) {
      case A3Messages.THR_LK:
        text = 'THR LK';
        className = 'FontMedium Amber';
        break;
      case A3Messages.LVR_TOGA:
        text = 'LVR TOGA';
        className = 'FontMedium White';
        break;
      case A3Messages.LVR_CLB:
        text = 'LVR CLB';
        className = 'FontMedium White';
        break;
      case A3Messages.LVR_MCT:
        text = 'LVR MCT';
        className = 'FontMedium White';
        break;
      case A3Messages.LVR_ASYM:
        text = 'LVR ASYM';
        className = 'FontMedium Amber';
        break;
      case A3Messages.BRK_RTO:
        text = 'BRK RTO';
        className = 'FontMediumSmaller Cyan';
        break;
      default:
        text = '';
    }

    this.textSub.set(text);
    this.classSub.set(className);
  }

  private readonly shouldFlash = this.props.A3Message.map(
    (A3Message) => A3Message !== A3Messages.BRK_RTO && A3Message !== A3Messages.LVR_ASYM,
  );

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.A3Message.sub((a3) => {
      this.onUpdateAthrModeMessage(a3);
    }, true);
  }

  render(): VNode {
    return (
      <FlashOneHertz bus={this.props.bus} flashDuration={Infinity} flashing={this.shouldFlash}>
        <span class={this.classSub} style={textStyle(16.989958, ROW_3_TOP)}>
          {this.textSub}
        </span>
      </FlashOneHertz>
    );
  }
}

interface AB3CellProps extends CellProps {
  A3Message: Subscribable<A3Messages>;
}

class AB3Cell extends DisplayComponent<AB3CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private machPresel = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_presel_mach'));

  private speedPresel = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_presel_speed'));

  private readonly textSub = MappedSubject.create(
    ([machPresel, speedPresel, A3Message]) => {
      if (A3Message !== A3Messages.NONE) {
        return '';
      } else if (speedPresel.isNormalOperation() && !machPresel.isNormalOperation()) {
        return `SPEED SEL ${speedPresel.value}`;
      } else if (!speedPresel.isNormalOperation() && machPresel.isNormalOperation()) {
        return `MACH SEL ${machPresel.value.toFixed(2)}`;
      } else {
        return '';
      }
    },
    this.machPresel,
    this.speedPresel,
    this.props.A3Message,
  );

  render(): VNode {
    return (
      <span class="FontMedium Cyan" style={textStyle(35.434673, ROW_3_TOP)}>
        {this.textSub}
      </span>
    );
  }
}

interface B1CellProps extends CellProps {
  B1Message: Subscribable<B1Messages>;
}

class B1Cell extends ShowForSecondsComponent<B1CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord3 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_3'));

  private primFgDiscreteWord5 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_5'));

  private primFgDiscreteWord6 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_6'));

  private primFgSelectedVs = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_selected_vertical_speed'));

  private primFgSelectedFpa = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_selected_flight_path_angle'));

  private readonly tcasLargeBoxDemand = this.primFgDiscreteWord6.map((word) => word.bitValueOr(11, false));

  private readonly targetNotHeld = this.primFgDiscreteWord5.map((word) => word.bitValueOr(29, false));

  private readonly text = MappedSubject.create(
    ([B1Message, primFgSelectedFpa]) => {
      this.isShown = true;

      switch (B1Message) {
        case B1Messages.NONE:
          this.isShown = false;
          return '';

        case B1Messages.GS:
          return 'G/S';
        case B1Messages.F_GS:
          return 'F-G/S';
        case B1Messages.GS_STAR:
          return 'G/S*';
        case B1Messages.F_GS_STAR:
          return 'F-G/S*';
        case B1Messages.SRS:
          return 'SRS';
        case B1Messages.TCAS:
          return 'TCAS';
        case B1Messages.APP_DES:
          return 'APP-DES';
        case B1Messages.DES:
          return 'DES';
        case B1Messages.OP_DES:
          return 'OP DES';
        case B1Messages.CLB:
          return 'CLB';
        case B1Messages.OP_CLB:
          return 'OP CLB';
        case B1Messages.ALT:
          return 'ALT';
        case B1Messages.ALT_STAR:
          return 'ALT*';
        case B1Messages.ALT_CST:
          return 'ALT CST';
        case B1Messages.ALT_CST_STAR:
          return 'ALT CST*';
        case B1Messages.ALT_CRZ:
          return 'ALT CRZ';
        case B1Messages.ALT_CRZ_STAR:
          return 'ALT CRZ*';
        case B1Messages.FPA: {
          let text = 'FPA';
          const fpaValue = primFgSelectedFpa.value;

          // if FPA is 0 give it an empty space for where the '+' and '-' will be.
          if (!(primFgSelectedFpa.isNoComputedData() || primFgSelectedFpa.isFailureWarning()) && fpaValue === 0) {
            text += ' ';
          }
          return text;
        }
        case B1Messages.VS:
          return 'V/S';
        default:
          this.isShown = false;
          return '';
      }
    },
    this.props.B1Message,
    this.primFgSelectedFpa,
  );

  private readonly additionalText = MappedSubject.create(
    ([B1Message, primFgSelectedVs, primFgSelectedFpa]) => {
      if (B1Message === B1Messages.FPA) {
        if (!(primFgSelectedFpa.isNoComputedData() || primFgSelectedFpa.isFailureWarning())) {
          const fpaValue = primFgSelectedFpa.value;
          return `${fpaValue > 0 ? '+' : ''}${(Math.round(fpaValue * 10) / 10).toFixed(1)}°`;
        } else {
          return '-----';
        }
      } else if (B1Message === B1Messages.VS) {
        if (!(primFgSelectedVs.isNoComputedData() || primFgSelectedVs.isFailureWarning())) {
          const vsValue = primFgSelectedVs.value;
          return `${vsValue > 0 ? '+' : ''}${Math.round(vsValue).toString()}`.padStart(5, '\xa0');
        } else {
          return '-----';
        }
      } else {
        return '';
      }
    },
    this.props.B1Message,
    this.primFgSelectedVs,
    this.primFgSelectedFpa,
  );

  private readonly inSpeedProtection = MappedSubject.create(
    ([text, targetNotHeld]) => {
      return targetNotHeld && text !== '';
    },
    this.text,
    this.targetNotHeld,
  );

  private readonly boxClassSub = this.inSpeedProtection.map((inSpeedProtection) =>
    inSpeedProtection ? 'None' : 'White',
  );

  private readonly boxHeightSub = MappedSubject.create(
    ([tcasLargeBoxDemand, primFgDiscreteWord3]) => {
      return tcasLargeBoxDemand && primFgDiscreteWord3.bitValueOr(25, false)
        ? `${px(13.506)}px`
        : `${px(ROW_HEIGHT)}px`;
    },
    this.tcasLargeBoxDemand,
    this.primFgDiscreteWord3,
  );

  private readonly activeVerticalModeClassSub = this.primFgDiscreteWord3.map((word) => {
    // VS FPA has a smaller font than the other active modes
    const fpaMode = word.bitValueOr(18, false);
    const vsMode = word.bitValueOr(17, false);

    // ALT CRZ* also has a smaller font, as it otherwise would be too large for the box.
    const altCstrApplicable = word.bitValueOr(28, false);
    const altIsCrzAlt = word.bitValueOr(29, false);
    const altAcqMode = word.bitValueOr(19, false);

    return vsMode || fpaMode || (altAcqMode && !altCstrApplicable && altIsCrzAlt)
      ? 'FontMediumSmaller Green'
      : 'FontMedium Green';
  });

  constructor(props: B1CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.text.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class={this.boxClassSub}
          style={{
            position: 'absolute',
            left: `${px(35.756)}px`,
            top: `${px(ROW_1_TOP)}px`,
            width: `${px(27.918)}px`,
            height: this.boxHeightSub,
            border: BOX_BORDER,
            'box-sizing': 'border-box',
            visibility: 'hidden',
          }}
        />

        <FlashOneHertz bus={this.props.bus} flashDuration={Infinity} visible={this.inSpeedProtection}>
          <div class="Amber" style={boxStyle(34.656, ROW_1_TOP, 29.918, ROW_HEIGHT)} />
        </FlashOneHertz>

        <span class={this.activeVerticalModeClassSub} style={textStyle(49.921795, ROW_1_TOP)}>
          <span>{this.text}</span>
          <FlashOneHertz
            bus={this.props.bus}
            flashDuration={Infinity}
            flashing={this.inSpeedProtection}
            className1={'Cyan'}
            className2={'DimmedCyan Fill'}
          >
            <span style="white-space: pre">{this.additionalText}</span>
          </FlashOneHertz>
        </span>
      </div>
    );
  }
}

class B2Cell extends DisplayComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_2'));

  private primFgDiscreteWord3 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_3'));

  private classSub = MappedSubject.create(
    ([primFgDiscreteWord2, primFgDiscreteWord3]) => {
      const altAcqArmed = primFgDiscreteWord2.bitValueOr(11, false);

      const altCstrApplicable = primFgDiscreteWord3.bitValueOr(28, false);

      return altAcqArmed && altCstrApplicable ? 'FontMediumSmaller Magenta' : 'FontMediumSmaller Cyan';
    },
    this.primFgDiscreteWord2,
    this.primFgDiscreteWord3,
  );

  private text1Sub = MappedSubject.create(
    ([primFgDiscreteWord2, primFgDiscreteWord3]) => {
      const altAcqArmed = primFgDiscreteWord2.bitValueOr(11, false);
      const clbArmed = primFgDiscreteWord2.bitValueOr(15, false);
      const desArmed = primFgDiscreteWord2.bitValueOr(16, false);
      const opClbArmed = primFgDiscreteWord2.bitValueOr(17, false);

      const gsArmed = primFgDiscreteWord2.bitValueOr(13, false);
      const altCstrApplicable = primFgDiscreteWord3.bitValueOr(28, false);
      const altIsCrzAlt = primFgDiscreteWord3.bitValueOr(29, false);

      if (opClbArmed) {
        return '      OP CLB';
      } else if (clbArmed) {
        return '      CLB';
      } else if (desArmed) {
        return gsArmed ? 'DES ' : '      DES';
      } else if (altAcqArmed && altCstrApplicable) {
        return gsArmed ? 'ALT ' : '      ALT';
      } else if (altAcqArmed && altIsCrzAlt) {
        return '     ALT CRZ';
      } else if (altAcqArmed) {
        return gsArmed ? 'ALT ' : '      ALT';
      } else if (gsArmed) {
        return '      G/S';
      } else {
        return '';
      }
    },
    this.primFgDiscreteWord2,
    this.primFgDiscreteWord3,
  );

  private text2Sub = MappedSubject.create(
    ([primFgDiscreteWord2, text1Sub]) => {
      const gsArmed = primFgDiscreteWord2.bitValueOr(13, false);

      //TODO Improve this logic, very ugly
      if (gsArmed && text1Sub !== '      G/S') {
        return '  G/S';
      } else if (primFgDiscreteWord2.bitValueOr(14, false)) {
        return 'APP-DES';
      } else {
        return '';
      }
    },
    this.primFgDiscreteWord2,
    this.text1Sub,
  );

  render(): VNode {
    return (
      <div>
        <span class={this.classSub} style={textStyle(40.777474, ROW_2_TOP)}>
          {this.text1Sub}
        </span>
        <span class="FontMediumSmaller Cyan" style={textStyle(56.19803, ROW_2_TOP)}>
          {this.text2Sub}
        </span>
      </div>
    );
  }
}

class C1Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord4 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_4'));

  private readonly message = this.primFgDiscreteWord4.map((primFgDiscreteWord4) =>
    computeC1Message(primFgDiscreteWord4),
  );

  private readonly text = this.message.map((C1Message) => {
    this.isShown = true;
    switch (C1Message) {
      case C1Messages.GA_TRK:
        return 'GA TRK';
      case C1Messages.LOC_BC_STAR:
        return 'LOC B/C*';
      case C1Messages.LOC_STAR:
        return 'LOC *';
      case C1Messages.F_LOC_STAR:
        return 'F-LOC *';
      case C1Messages.HDG:
        return 'HDG';
      case C1Messages.RWY:
        return 'RWY';
      case C1Messages.RWY_TRK:
        return 'RWY TRK';
      case C1Messages.TRACK:
        return 'TRACK';
      case C1Messages.LOC_BC:
        return 'LOC B/C';
      case C1Messages.LOC:
        return 'LOC';
      case C1Messages.F_LOC:
        return 'F-LOC';
      case C1Messages.NAV:
        return 'NAV';
      default:
        this.isShown = false;
        return '';
    }
  });

  constructor(props: CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.text.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(68.795, ROW_1_TOP, 31.075, ROW_HEIGHT)} visibility: hidden;`}
        />
        <span class="FontMedium Green" style={textStyle(84.856567, ROW_1_TOP)}>
          {this.text}
        </span>
      </div>
    );
  }
}

class C2Cell extends DisplayComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_2'));

  private primFgDiscreteWord4 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_4'));

  private readonly text = MappedSubject.create(
    ([primFgDiscreteWord2, primFgDiscreteWord4]) => {
      const navArmed = primFgDiscreteWord2.bitValueOr(22, false);
      const locArmed = primFgDiscreteWord2.bitValueOr(23, false);
      const rwyArmed = primFgDiscreteWord2.bitValueOr(24, false);
      const backbeamMode = primFgDiscreteWord4.bitValueOr(29, false);

      if (locArmed && backbeamMode) {
        return 'LOC B/C';
      } else if (locArmed) {
        return 'LOC';
      } else if (false) {
        return 'F-LOC';
      } else if (rwyArmed) {
        return 'RWY' + (navArmed ? '  NAV' : '');
      } else if (navArmed) {
        return 'NAV';
      }
    },
    this.primFgDiscreteWord2,
    this.primFgDiscreteWord4,
  );

  render(): VNode {
    return (
      <span class="FontMediumSmaller Cyan" style={textStyle(84.234184, ROW_2_TOP)}>
        {this.text}
      </span>
    );
  }
}

class BC1Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private primFgDiscreteWord3 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_3'));

  private primFgDiscreteWord4 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_4'));

  private readonly text = MappedSubject.create(
    ([primFgDiscreteWord1, primFgDiscreteWord3, primFgDiscreteWord4]) => {
      const rollOutActive = primFgDiscreteWord4.bitValueOr(26, false);
      const flareActive = primFgDiscreteWord3.bitValueOr(24, false);
      const landActive = primFgDiscreteWord1.bitValueOr(23, false) && !flareActive && !rollOutActive;

      this.isShown = true;
      if (rollOutActive) {
        return 'ROLL OUT';
      } else if (flareActive) {
        return 'FLARE';
      } else if (landActive) {
        return 'LAND';
      } else {
        this.isShown = false;
        return '';
      }
    },
    this.primFgDiscreteWord1,
    this.primFgDiscreteWord3,
    this.primFgDiscreteWord4,
  );

  constructor(props: CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.text.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(50.178, ROW_1_TOP, 35.174, ROW_HEIGHT)} visibility: hidden;`}
        />
        <span class="FontMedium Green" style={textStyle(67.9795, ROW_1_TOP)}>
          {this.text}
        </span>
      </div>
    );
  }
}

class BC3Cell extends DisplayComponent<{
  readonly BC3Message: Subscribable<BC3Messages>;
}> {
  private bc3Cell = FSComponent.createRef<HTMLSpanElement>();

  private classNameSub = Subject.create('');

  private getBC3MessageText(BC3Message: BC3Messages) {
    let text: string;
    let className: string;

    switch (BC3Message) {
      case BC3Messages.USE_MAN_PITCH_TRIM:
        text = 'USE MAN PITCH TRIM';
        className = 'PulseAmber9Seconds Amber';
        break;
      case BC3Messages.FOR_GA_SET_TOGA:
        text = 'FOR GA: SET TOGA';
        className = 'PulseAmber9Seconds Amber';
        break;
      case BC3Messages.DISCONNECT_AP_FOR_LDG:
        text = 'DISCONNECT AP FOR LDG';
        className = 'FontSmall PulseAmber9Seconds Amber';
        break;
      case BC3Messages.TCAS_ARMED:
        text = 'TCAS           ';
        className = 'FontMediumSmaller Cyan';
        break;
      case BC3Messages.TCAS_RA_INHIBITED:
        text = 'TCAS RA INHIBITED';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.TRK_FPA_DESELECTED:
        text = 'TRK FPA DESELECTED';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.MOVE_THR_LEVERS:
        text = 'MOVE THR LEVERS';
        className = 'BlinkInfinite Amber';
        break;
      case BC3Messages.TD_REACHED:
        text = 'T/D REACHED';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.EXTEND_SPD_BRK:
        text = 'EXTEND SPD BRK';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.RETRACT_SPD_BRK:
        text = 'RETRACT SPD BRK';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.CHECK_APPR_SEL:
        text = 'CHECK APPR SEL';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.SET_HOLD_SPD:
        text = 'SET HOLD SPD';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.EXIT_MISSED:
        text = 'EXIT MISSED';
        className = 'FontMediumSmaller White';
        break;
      case BC3Messages.FCU_ALT_BELOW_AC:
        text = 'FCU ALT BELOW A/C';
        className = 'FontMediumSmaller  White';
        break;
      case BC3Messages.FCU_ALT_ABOVE_AC:
        text = 'FCU ALT ABOVE A/C';
        className = 'FontMediumSmaller White';
        break;
      default:
        return [null, null];
    }

    return [text, className];
  }

  private fillBC3Cell() {
    const [text, className] = this.getBC3MessageText(this.props.BC3Message.get());
    this.classNameSub.set(`FontMedium ${className}`);
    this.bc3Cell.instance.textContent = text ?? '';
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.BC3Message.sub(() => {
      this.fillBC3Cell();
    }, true);
  }

  render(): VNode {
    return <span ref={this.bc3Cell} class={this.classNameSub} style={textStyle(68.087875, ROW_3_TOP)} />;
  }
}

class D1D2Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<
    PrimFgBusBaseEvents & FcdcBusBaseEvents & FcuEfisCpBusEvents & PFDSimvars
  >();

  private readonly primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private readonly primFgDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_2'));

  private readonly fcdcFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('fcdc_fg_discrete_word_1'));

  private readonly fcuEisDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(null);

  private readonly lsButton = this.fcuEisDiscreteWord2.map((word) => word.bitValueOr(14, true));

  private readonly hasLoc = ConsumerSubject.create(this.sub.on('hasLoc'), false);

  private readonly hasGs = ConsumerSubject.create(this.sub.on('hasGlideslope'), false);

  private readonly appr1Condition = MappedSubject.create(
    ([lsButton, hasLoc, hasGs]) => lsButton && hasGs && hasLoc,
    this.lsButton,
    this.hasLoc,
    this.hasGs,
  );

  private readonly D1D2Message = MappedSubject.create(
    ([primFgDiscreteWord1, primFgDiscreteWord2, fcdcFgDiscreteWord1, appr1Condition]) => {
      return computeD1D2Message(primFgDiscreteWord1, primFgDiscreteWord2, fcdcFgDiscreteWord1, appr1Condition);
    },
    this.primFgDiscreteWord1,
    this.primFgDiscreteWord2,
    this.fcdcFgDiscreteWord1,
    this.appr1Condition,
  );

  private readonly text1Sub = this.D1D2Message.map((message) => {
    this.isShown = true;

    if (message == D1D2Messages.LAND_2) {
      return 'LAND2';
    } else if (message == D1D2Messages.LAND_3_DUAL || message == D1D2Messages.LAND_3_SINGLE) {
      return 'LAND3';
    } else if (message == D1D2Messages.APPR_1) {
      return 'APPR1';
    } else if (message == D1D2Messages.F_APP || message == D1D2Messages.F_APP_RAW) {
      return 'F-APP';
    } else if (message == D1D2Messages.RAW_ONLY) {
      return 'RAW';
    } else if (message == D1D2Messages.LAND_1) {
      return 'LAND1';
    } else {
      this.isShown = false;

      return '';
    }
  });

  private readonly text2Sub = this.D1D2Message.map((message) => {
    this.isShown = true;

    if (
      message == D1D2Messages.LAND_1 ||
      message == D1D2Messages.APPR_1 ||
      message == D1D2Messages.LAND_2 ||
      message == D1D2Messages.F_APP
    ) {
      return '';
    } else if (message == D1D2Messages.LAND_3_SINGLE) {
      return 'SINGLE';
    } else if (message == D1D2Messages.LAND_3_DUAL) {
      return 'DUAL';
    } else if (message == D1D2Messages.F_APP_RAW) {
      return '+RAW';
    } else if (message == D1D2Messages.RAW_ONLY) {
      return 'ONLY';
    } else {
      return '';
    }
  });

  /** [left, width, height] of the mode-change box in viewBox units, per message. */
  private readonly modeChangeBoxGeometry = this.D1D2Message.map((message): [number, number, number] => {
    if (
      message == D1D2Messages.LAND_1 ||
      message == D1D2Messages.APPR_1 ||
      message == D1D2Messages.LAND_2 ||
      message == D1D2Messages.F_APP
    ) {
      return [108.1, 19.994, ROW_HEIGHT];
    } else if (
      message == D1D2Messages.LAND_3_DUAL ||
      message == D1D2Messages.LAND_3_SINGLE ||
      message == D1D2Messages.F_APP_RAW
    ) {
      return [107.1, 22.994, 13.506];
    } else if (message == D1D2Messages.RAW_ONLY) {
      return [110.1, 15.994, 13.506];
    } else {
      return [108.1, 19.994, ROW_HEIGHT];
    }
  });

  constructor(props: CellProps) {
    super(props, 9);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const isFo = getDisplayIndex() === 2;

    this.fcuEisDiscreteWord2.setConsumer(
      this.sub.on(isFo ? 'fcu_efis_r_discrete_word_2' : 'fcu_efis_l_discrete_word_2'),
    );

    this.D1D2Message.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <span class="FontMedium White" style={textStyle(118.45866, ROW_1_TOP)}>
          {this.text1Sub}
        </span>
        <span class="FontMedium White" style={textStyle(118.39752, ROW_2_TOP)}>
          {this.text2Sub}
        </span>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={{
            position: 'absolute',
            left: this.modeChangeBoxGeometry.map(([x]) => `${px(x)}px`),
            top: `${px(ROW_1_TOP)}px`,
            width: this.modeChangeBoxGeometry.map(([, w]) => `${px(w)}px`),
            height: this.modeChangeBoxGeometry.map(([, , h]) => `${px(h)}px`),
            border: BOX_BORDER,
            'box-sizing': 'border-box',
            visibility: 'hidden',
          }}
        />
      </div>
    );
  }
}

enum MdaMode {
  None = '',
  NoDh = 'NO DH',
  Radio = 'RADIO',
  Baro = 'BARO',
}

class D3Cell extends DisplayComponent<{ bus: ArincEventBus }> {
  private readonly sub = this.props.bus.getArincSubscriber<PFDSimvars & Arinc429Values>();

  /** bit 29 is NO DH selection */
  private readonly fmEisDiscrete2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('fmEisDiscreteWord2Raw'));

  private readonly mda = Arinc429LocalVarConsumerSubject.create(this.sub.on('fmMdaRaw'));

  private readonly dh = Arinc429LocalVarConsumerSubject.create(this.sub.on('fmDhRaw'));

  private readonly noDhSelected = this.fmEisDiscrete2.map((r) => r.bitValueOr(29, false));

  private readonly mdaDhMode = MappedSubject.create(
    ([noDh, dh, mda]) => {
      if (noDh) {
        return MdaMode.NoDh;
      }

      if (!dh.isNoComputedData() && !dh.isFailureWarning()) {
        return MdaMode.Radio;
      }

      if (!mda.isNoComputedData() && !mda.isFailureWarning()) {
        return MdaMode.Baro;
      }

      return MdaMode.None;
    },
    this.noDhSelected,
    this.dh,
    this.mda,
  );

  private readonly mdaDhValueText = MappedSubject.create(
    ([mdaMode, dh, mda]) => {
      switch (mdaMode) {
        case MdaMode.Baro:
          return Math.round(mda.value).toString().padStart(6, '\xa0');
        case MdaMode.Radio:
          return Math.round(dh.value).toString().padStart(4, '\xa0');
        default:
          return '';
      }
    },
    this.mdaDhMode,
    this.dh,
    this.mda,
  );

  render(): VNode {
    return (
      <div>
        <span
          class={{
            FontSmallest: this.noDhSelected.map(SubscribableMapFunctions.not()),
            FontMedium: this.noDhSelected,
            White: true,
          }}
          style={{
            position: 'absolute',
            left: this.noDhSelected.map((noDh) => `${px(noDh ? 118.38384 : 103.47)}px`),
            top: `${px(ROW_3_TOP)}px`,
            height: `${px(ROW_HEIGHT)}px`,
            display: 'flex',
            'align-items': 'center',
            'white-space': 'pre',
            transform: this.noDhSelected.map((noDh) => (noDh ? 'translateX(-50%)' : 'none')),
          }}
        >
          {this.mdaDhMode}
        </span>
        <span
          class={{
            FontSmallest: true,
            Cyan: true,
            HiddenElement: this.mdaDhValueText.map((v) => v.length <= 0),
          }}
          style={textStyle(133.425, ROW_3_TOP, 'end')}
        >
          {this.mdaDhValueText}
        </span>
      </div>
    );
  }
}

class E1Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private ap1Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(11, false));

  private ap2Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(12, false));

  private textSub = MappedSubject.create(
    ([ap1Engaged, ap2Engaged]) => {
      this.isShown = true;
      if (ap1Engaged && ap2Engaged) {
        return 'AP1+2';
      } else if (ap1Engaged) {
        return 'AP1';
      } else if (ap2Engaged) {
        return 'AP2';
      } else {
        this.isShown = false;
        return '';
      }
    },
    this.ap1Engaged,
    this.ap2Engaged,
  );

  constructor(props: CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.textSub.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(135.32, ROW_1_TOP, 20.81, ROW_HEIGHT)} visibility: hidden;`}
        />
        <span class="FontMedium White" style={textStyle(145.61546, ROW_1_TOP)}>
          {this.textSub}
        </span>
      </div>
    );
  }
}

class E2Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private ap1Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(11, false));

  private ap2Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(12, false));

  private fd1Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(13, false));

  private fd2Engaged = this.primFgDiscreteWord1.map((word) => word.bitValueOr(14, false));

  private textSub = MappedSubject.create(
    ([ap1Engaged, ap2Engaged, fd1Engaged, fd2Engaged]) => {
      this.isShown = true;
      if (!ap1Engaged && !ap2Engaged && !fd1Engaged && !fd2Engaged) {
        this.isShown = false;
        return '';
      } else {
        return `${fd1Engaged ? '1' : '-'}FD${fd2Engaged ? '2' : '-'}`;
      }
    },
    this.ap1Engaged,
    this.ap2Engaged,
    this.fd1Engaged,
    this.fd2Engaged,
  );

  constructor(props: CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.textSub.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(135.32, ROW_2_TOP, 20.81, ROW_HEIGHT)} visibility: hidden;`}
        />
        <span class="FontMedium White" style={`${textStyle(145.95045, ROW_2_TOP)} word-spacing: -9.6px;`}>
          {this.textSub}
        </span>
      </div>
    );
  }
}

class E3Cell extends ShowForSecondsComponent<CellProps> {
  private sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents>();

  private primFgAtsDiscreteWord = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_ats_discrete_word'));

  private athrEngaged = this.primFgAtsDiscreteWord.map((word) => word.bitValueOr(11, false));

  private athrActive = this.primFgAtsDiscreteWord.map((word) => word.bitValueOr(12, false));

  private classSub = MappedSubject.create(
    ([athrEngaged, athrActive]) => {
      this.isShown = true;
      if (athrEngaged && athrActive) {
        this.isShown = false;
        return 'FontMedium White';
      } else if (athrEngaged) {
        return 'FontMedium Cyan';
      } else {
        this.isShown = false;
        return 'HiddenElement';
      }
    },
    this.athrEngaged,
    this.athrActive,
  );

  constructor(props: CellProps) {
    super(props, 10);
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.classSub.sub(() => {
      this.displayModeChangedPath();
    });
  }

  render(): VNode {
    return (
      <div>
        <div
          ref={this.modeChangedPathRef}
          class="White"
          style={`${boxStyle(135.32, ROW_3_TOP, 20.81, ROW_HEIGHT)} visibility: hidden;`}
        />
        <span class={this.classSub} style={textStyle(145.75578, ROW_3_TOP)}>
          A/THR
        </span>
      </div>
    );
  }
}
