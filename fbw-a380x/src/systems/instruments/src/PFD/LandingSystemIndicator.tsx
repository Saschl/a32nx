// @ts-strict-ignore
import {
  ConsumerSubject,
  DisplayComponent,
  EventBus,
  FSComponent,
  MappedSubject,
  Subject,
  Subscribable,
  VNode,
} from '@microsoft/msfs-sdk';
import { getDisplayIndex } from './PFD';
import { Arinc429ConsumerSubject, Arinc429LocalVarConsumerSubject, ArincEventBus } from '@flybywiresim/fbw-sdk';
import { Arinc429Values } from './shared/ArincValueProvider';
import { PFDSimvars } from './shared/PFDSimvarPublisher';
import { LagFilter } from './PFDUtils';
import { FcuEfisCpBusEvents } from '@shared/publishers/EfisCpBusPublisher';
import { FlashOneHertz } from '../MsfsAvionicsCommon/FlashingElementUtils';
import { PrimFgBusBaseEvents } from '@shared/publishers/PrimFgPublisher';

export class LandingSystem extends DisplayComponent<{ bus: ArincEventBus; instrument: BaseInstrument }> {
  private readonly sub = this.props.bus.getArincSubscriber<Arinc429Values & FcuEfisCpBusEvents>();

  private readonly altitude = Arinc429ConsumerSubject.create(this.sub.on('altitudeAr'));

  private readonly fcuEisDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(null);

  private readonly lsButtonPressed = this.fcuEisDiscreteWord2.map((word) => word.bitValueOr(14, true));

  private lsButtonPressedVisibility = false;

  private xtkValid = Subject.create(false);

  private ldevRequest = false;

  private lsGroupRef = FSComponent.createRef<SVGGElement>();

  private gsReferenceLine = FSComponent.createRef<SVGPathElement>();

  private deviationGroup = FSComponent.createRef<SVGGElement>();

  private ldevRef = FSComponent.createRef<SVGGElement>();

  private vdevRef = FSComponent.createRef<SVGGElement>();

  private handleGsReferenceLine() {
    if (this.lsButtonPressedVisibility || this.altitude.get().isNormalOperation()) {
      this.gsReferenceLine.instance.style.display = 'inline';
    } else if (!this.lsButtonPressedVisibility) {
      this.gsReferenceLine.instance.style.display = 'none';
    }
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const isFo = getDisplayIndex() === 2;

    this.fcuEisDiscreteWord2.setConsumer(
      this.sub.on(isFo ? 'fcu_efis_r_discrete_word_2' : 'fcu_efis_l_discrete_word_2'),
    );

    this.lsButtonPressed.sub((lsButton) => {
      this.lsButtonPressedVisibility = lsButton;
      this.lsGroupRef.instance.style.display = this.lsButtonPressedVisibility ? 'inline' : 'none';
      this.deviationGroup.instance.style.display = this.lsButtonPressedVisibility ? 'none' : 'inline';
      this.handleGsReferenceLine();
    }, true);

    const sub = this.props.bus.getSubscriber<PFDSimvars & Arinc429Values>();

    this.altitude.sub(this.handleGsReferenceLine.bind(this), true);

    sub
      .on(getDisplayIndex() === 1 ? 'ldevRequestLeft' : 'ldevRequestRight')
      .whenChanged()
      .handle((ldevRequest) => {
        this.ldevRequest = ldevRequest;
        this.updateLdevVisibility();
      });

    sub
      .on('xtk')
      .whenChanged()
      .handle((xtk) => {
        this.xtkValid.set(Math.abs(xtk) > 0);
      });

    this.xtkValid.sub(() => {
      this.updateLdevVisibility();
    });
  }

  updateLdevVisibility() {
    this.ldevRef.instance.style.display = this.ldevRequest && this.xtkValid ? 'inline' : 'none';
  }

  render(): VNode {
    return (
      <>
        <g id="LSGroup" ref={this.lsGroupRef} style="display: none">
          <LandingSystemInfo bus={this.props.bus} isVisible={this.lsButtonPressed} />

          <g id="LSGroup">
            <LocalizerIndicator bus={this.props.bus} instrument={this.props.instrument} />
            <GlideSlopeIndicator bus={this.props.bus} instrument={this.props.instrument} />
            <MarkerBeaconIndicator bus={this.props.bus} />
            <LsTitle bus={this.props.bus} />
          </g>
          <path ref={this.gsReferenceLine} class="Yellow Fill" d="m115.52 80.067v1.5119h-8.9706v-1.5119z" />
        </g>

        <g>
          <LsReminderIndicator bus={this.props.bus} />
        </g>
        <g id="DeviationGroup" ref={this.deviationGroup} style="display: none">
          <g id="LateralDeviationGroup" ref={this.ldevRef} style="display: none">
            <LDevIndicator bus={this.props.bus} />
          </g>
          <g id="VerticalDeviationGroup" ref={this.vdevRef} style="display: none">
            <VDevIndicator bus={this.props.bus} />
          </g>
        </g>
        <path ref={this.gsReferenceLine} class="Yellow Fill" d="m115.52 80.067v1.5119h-8.9706v-1.5119z" />
      </>
    );
  }
}

class LandingSystemInfo extends DisplayComponent<{ bus: EventBus; isVisible: Subscribable<boolean> }> {
  private hasDme = false;

  private identText = Subject.create('');

  private freqTextLeading = Subject.create('');

  private freqTextTrailing = Subject.create('');

  private navFreq = 0;

  private dme = 0;

  private dmeVisibilitySub = Subject.create('hidden');

  private lastDistDisplayed = NaN;

  private readonly dmeDistLeadingRef = FSComponent.createRef<SVGTSpanElement>();

  private readonly dmeDistTrailingRef = FSComponent.createRef<SVGTSpanElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    sub
      .on('hasDme')
      .whenChanged()
      .handle((hasDme) => {
        this.hasDme = hasDme;
        this.updateDmeText();
      });

    sub
      .on('navIdent')
      .whenChanged()
      .handle((navIdent) => {
        this.identText.set(navIdent);
      });

    sub
      .on('navFreq')
      .whenChanged()
      .handle((navFreq) => {
        this.navFreq = navFreq;
        this.updateFreqText();
      });

    sub
      .on('dme')
      .whenChanged()
      .handle((dme) => {
        this.dme = dme;
        this.updateDmeText();
      });
  }

  private updateFreqText() {
    const freqTextSplit = (Math.round(this.navFreq * 1000) / 1000).toString().split('.');
    this.freqTextLeading.set(freqTextSplit[0] === '0' ? '' : freqTextSplit[0]);
    if (freqTextSplit[1]) {
      this.freqTextTrailing.set(`.${freqTextSplit[1].padEnd(2, '0')}`);
    } else {
      this.freqTextTrailing.set('');
    }
  }

  // dme changes on effectively every frame while receiving; only rebuild the text when the
  // displayed (0.1 NM) value changed
  private updateDmeText() {
    if (this.hasDme) {
      this.dmeVisibilitySub.set('display: inline');
      const dist = Math.round(this.dme * 10) / 10;
      if (dist !== this.lastDistDisplayed) {
        this.lastDistDisplayed = dist;
        if (dist < 20) {
          const distSplit = dist.toString().split('.');
          this.dmeDistLeadingRef.instance.textContent = distSplit[0];
          this.dmeDistTrailingRef.instance.textContent = `.${distSplit.length > 1 ? distSplit[1] : '0'}`;
        } else {
          this.dmeDistLeadingRef.instance.textContent = Math.round(dist).toString();
          this.dmeDistTrailingRef.instance.textContent = '';
        }
      }
    } else {
      this.dmeVisibilitySub.set('display: none');
      this.lastDistDisplayed = NaN;
    }
  }

  render(): VNode {
    return (
      <g id="LSInfoGroup" class={{ HiddenElement: this.props.isVisible.map((v) => !v) }}>
        <text id="ILSIdent" class="Magenta FontLarge AlignLeft" x="1.184" y="143.11522">
          {this.identText}
        </text>
        <text id="ILSFreqLeading" class="Magenta FontLarge AlignLeft" x="1.3610243" y="149.11575">
          {this.freqTextLeading}
        </text>
        <text id="ILSFreqTrailing" class="Magenta FontLarge AlignLeft" x="12.964463" y="149.24084">
          {this.freqTextTrailing}
        </text>

        <g id="ILSDistGroup" style={this.dmeVisibilitySub}>
          <text class="Magenta AlignLeft" x="1.3685881" y="155.26602">
            <tspan ref={this.dmeDistLeadingRef} id="ILSDistLeading" class="FontLarge StartAlign" />
            <tspan ref={this.dmeDistTrailingRef} id="ILSDistTrailing" class="FontSmallest StartAlign" />
          </text>
          <text class="Cyan FontSmallest AlignLeft" x="17.159119" y="155.22606">
            NM
          </text>
        </g>
      </g>
    );
  }
}

class LocalizerIndicator extends DisplayComponent<{ bus: EventBus; instrument: BaseInstrument }> {
  private lagFilter = new LagFilter(1.5);

  private rightDiamond = FSComponent.createRef<SVGPathElement>();

  private leftDiamond = FSComponent.createRef<SVGPathElement>();

  private locDiamond = FSComponent.createRef<SVGPathElement>();

  private diamondGroup = FSComponent.createRef<SVGGElement>();

  private lastDiamondState: 'right' | 'left' | 'center' | undefined = undefined;

  private lastDiamondOffset = NaN;

  // Runs on every navRadialError event (effectively every frame while LOC is received);
  // class and transform writes are deduped against the previous state
  private handleNavRadialError(radialError: number): void {
    const deviation = this.lagFilter.step(radialError, this.props.instrument.deltaTime / 1000);
    const dots = deviation / 0.8;

    const state = dots > 2 ? 'right' : dots < -2 ? 'left' : 'center';
    if (state !== this.lastDiamondState) {
      this.lastDiamondState = state;
      this.rightDiamond.instance.classList.toggle('HiddenElement', state !== 'right');
      this.leftDiamond.instance.classList.toggle('HiddenElement', state !== 'left');
      this.locDiamond.instance.classList.toggle('HiddenElement', state !== 'center');
    }
    if (state === 'center') {
      const offset = Math.round(((dots * 30.221) / 2) * 100) / 100;
      if (offset !== this.lastDiamondOffset) {
        this.lastDiamondOffset = offset;
        this.locDiamond.instance.style.transform = `translate3d(${offset}px, 0px, 0px)`;
      }
    }
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    const navRadialSub = sub.on('navRadialError').handle(this.handleNavRadialError.bind(this), true);

    sub
      .on('hasLoc')
      .whenChanged()
      .handle((hasLoc) => {
        if (hasLoc) {
          this.diamondGroup.instance.classList.remove('HiddenElement');
          navRadialSub.resume(true);
        } else {
          this.diamondGroup.instance.classList.add('HiddenElement');
          this.lagFilter.reset();
          navRadialSub.pause();
        }
      });
  }

  render(): VNode {
    return (
      <g id="LocalizerSymbolsGroup">
        <path
          class="NormalStroke White"
          d="m54.804 130.51a1.0073 1.0079 0 1 0-2.0147 0 1.0073 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m39.693 130.51a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m85.024 130.51a1.0073 1.0079 0 1 0-2.0147 0 1.0073 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m100.13 130.51a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <g class="HiddenElement" ref={this.diamondGroup}>
          <path
            id="LocDiamondRight"
            ref={this.rightDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m99.127 133.03 3.7776-2.5198-3.7776-2.5198"
          />
          <path
            id="LocDiamondLeft"
            ref={this.leftDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m38.686 133.03-3.7776-2.5198 3.7776-2.5198"
          />
          <path
            id="LocDiamond"
            ref={this.locDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m65.129 130.51 3.7776 2.5198 3.7776-2.5198-3.7776-2.5198z"
          />
        </g>
        <path id="LocalizerNeutralLine" class="Yellow Fill" d="m68.098 134.5v-8.0635h1.5119v8.0635z" />
      </g>
    );
  }
}

class GlideSlopeIndicator extends DisplayComponent<{ bus: EventBus; instrument: BaseInstrument }> {
  private lagFilter = new LagFilter(1.5);

  private upperDiamond = FSComponent.createRef<SVGPathElement>();

  private lowerDiamond = FSComponent.createRef<SVGPathElement>();

  private glideSlopeDiamond = FSComponent.createRef<SVGPathElement>();

  private diamondGroup = FSComponent.createRef<SVGGElement>();

  private hasGlideSlope = false;

  private lastDiamondState: 'upper' | 'lower' | 'center' | undefined = undefined;

  private lastDiamondOffset = NaN;

  // Runs on every glideSlopeError event (effectively every frame while GS is received);
  // class and transform writes are deduped against the previous state
  private handleGlideSlopeError(glideSlopeError: number): void {
    const deviation = this.lagFilter.step(glideSlopeError, this.props.instrument.deltaTime / 1000);
    const dots = deviation / 0.4;

    const state = dots > 2 ? 'upper' : dots < -2 ? 'lower' : 'center';
    if (state !== this.lastDiamondState) {
      this.lastDiamondState = state;
      this.upperDiamond.instance.classList.toggle('HiddenElement', state !== 'upper');
      this.lowerDiamond.instance.classList.toggle('HiddenElement', state !== 'lower');
      this.glideSlopeDiamond.instance.classList.toggle('HiddenElement', state !== 'center');
    }
    if (state === 'center') {
      const offset = Math.round(((dots * 30.238) / 2) * 100) / 100;
      if (offset !== this.lastDiamondOffset) {
        this.lastDiamondOffset = offset;
        this.glideSlopeDiamond.instance.style.transform = `translate3d(0px, ${offset}px, 0px)`;
      }
    }
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    sub
      .on('hasGlideslope')
      .whenChanged()
      .handle((hasGlideSlope) => {
        this.hasGlideSlope = hasGlideSlope;
        if (hasGlideSlope) {
          this.diamondGroup.instance.classList.remove('HiddenElement');
        } else {
          this.diamondGroup.instance.classList.add('HiddenElement');
          this.lagFilter.reset();
        }
      });

    sub.on('glideSlopeError').handle((gs) => {
      if (this.hasGlideSlope) {
        this.handleGlideSlopeError(gs);
      }
    });
  }

  render(): VNode {
    return (
      <g id="LocalizerSymbolsGroup">
        <path
          class="NormalStroke White"
          d="m110.71 50.585a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m110.71 65.704a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m110.71 95.942a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <path
          class="NormalStroke White"
          d="m110.71 111.06a1.0074 1.0079 0 1 0-2.0147 0 1.0074 1.0079 0 1 0 2.0147 0z"
        />
        <g class="HideGSDiamond" ref={this.diamondGroup}>
          <path
            id="GlideSlopeDiamondLower"
            ref={this.upperDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m107.19 111.06 2.5184 3.7798 2.5184-3.7798"
          />
          <path
            id="GlideSlopeDiamondUpper"
            ref={this.lowerDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m107.19 50.585 2.5184-3.7798 2.5184 3.7798"
          />
          <path
            id="GlideSlopeDiamond"
            ref={this.glideSlopeDiamond}
            class="NormalStroke Magenta HiddenElement"
            d="m109.7 77.043-2.5184 3.7798 2.5184 3.7798 2.5184-3.7798z"
          />
        </g>
      </g>
    );
  }
}

class VDevIndicator extends DisplayComponent<{ bus: EventBus }> {
  private VDevSymbolLower = FSComponent.createRef<SVGPathElement>();

  private VDevSymbolUpper = FSComponent.createRef<SVGPathElement>();

  private VDevSymbol = FSComponent.createRef<SVGPathElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    // TODO use correct simvar once RNAV is implemented
    const deviation = 0;
    const dots = deviation / 100;

    if (dots > 2) {
      this.VDevSymbolLower.instance.style.visibility = 'visible';
      this.VDevSymbolUpper.instance.style.visibility = 'hidden';
      this.VDevSymbol.instance.style.visibility = 'hidden';
    } else if (dots < -2) {
      this.VDevSymbolLower.instance.style.visibility = 'hidden';
      this.VDevSymbolUpper.instance.style.visibility = 'visible';
      this.VDevSymbol.instance.style.visibility = 'hidden';
    } else {
      this.VDevSymbolLower.instance.style.visibility = 'hidden';
      this.VDevSymbolUpper.instance.style.visibility = 'hidden';
      this.VDevSymbol.instance.style.visibility = 'visible';
      this.VDevSymbol.instance.style.transform = `translate3d(0px, ${(dots * 30.238) / 2}px, 0px)`;
    }
  }

  render(): VNode {
    return (
      <g id="VertDevSymbolsGroup" style="display: none">
        <text class="FontSmall AlignRight Green" x="95.022" y="43.126">
          V/DEV
        </text>
        <path class="NormalStroke White" d="m108.7 65.704h2.0147" />
        <path class="NormalStroke White" d="m108.7 50.585h2.0147" />
        <path class="NormalStroke White" d="m108.7 111.06h2.0147" />
        <path class="NormalStroke White" d="m108.7 95.942h2.0147" />
        <path
          id="VDevSymbolLower"
          ref={this.VDevSymbolLower}
          class="NormalStroke Green"
          d="m107.19 111.06v2.0159h5.0368v-2.0159"
        />
        <path
          id="VDevSymbolUpper"
          ref={this.VDevSymbolUpper}
          class="NormalStroke Green"
          d="m107.19 50.585v-2.0159h5.0368v2.0159"
        />
        <path
          id="VDevSymbol"
          ref={this.VDevSymbol}
          class="NormalStroke Green"
          d="m112.22 78.807h-5.0368v4.0318h5.0368v-2.0159z"
        />
      </g>
    );
  }
}

class LDevIndicator extends DisplayComponent<{ bus: EventBus }> {
  private LDevSymbolLeft = FSComponent.createRef<SVGPathElement>();

  private LDevSymbolRight = FSComponent.createRef<SVGPathElement>();

  private LDevSymbol = FSComponent.createRef<SVGPathElement>();

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    sub
      .on('xtk')
      .whenChanged()
      .withPrecision(3)
      .handle((xtk) => {
        const dots = xtk / 0.1;

        if (dots > 2) {
          this.LDevSymbolRight.instance.style.visibility = 'visible';
          this.LDevSymbolLeft.instance.style.visibility = 'hidden';
          this.LDevSymbol.instance.style.visibility = 'hidden';
        } else if (dots < -2) {
          this.LDevSymbolRight.instance.style.visibility = 'hidden';
          this.LDevSymbolLeft.instance.style.visibility = 'visible';
          this.LDevSymbol.instance.style.visibility = 'hidden';
        } else {
          this.LDevSymbolRight.instance.style.visibility = 'hidden';
          this.LDevSymbolLeft.instance.style.visibility = 'hidden';
          this.LDevSymbol.instance.style.visibility = 'visible';
          this.LDevSymbol.instance.style.transform = `translate3d(${(dots * 30.238) / 2}px, 0px, 0px)`;
        }
      });
  }

  render(): VNode {
    return (
      <g id="LatDeviationSymbolsGroup">
        <text class="FontSmall AlignRight Green" x="30.888" y="122.639">
          L/DEV
        </text>
        <path class="NormalStroke White" d="m38.686 129.51v2.0158" />
        <path class="NormalStroke White" d="m53.796 129.51v2.0158" />
        <path class="NormalStroke White" d="m84.017 129.51v2.0158" />
        <path class="NormalStroke White" d="m99.127 129.51v2.0158" />
        <path
          id="LDevSymbolLeft"
          ref={this.LDevSymbolLeft}
          class="NormalStroke Green"
          d="m38.686 127.99h-2.0147v5.0397h2.0147"
        />
        <path
          id="LDevSymbolRight"
          ref={this.LDevSymbolRight}
          class="NormalStroke Green"
          d="m99.127 127.99h2.0147v5.0397h-2.0147"
        />
        <path
          id="LDevSymbol"
          ref={this.LDevSymbol}
          class="NormalStroke Green"
          d="m66.892 127.99v5.0397h4.0294v-5.0397h-2.0147z"
        />
        <path id="LDevNeutralLine" class="Yellow Fill" d="m68.098 134.5v-8.0635h1.5119v8.0635z" />
      </g>
    );
  }
}

class MarkerBeaconIndicator extends DisplayComponent<{ bus: EventBus }> {
  private classNames = Subject.create('HiddenElement');

  private markerText = Subject.create('');

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const sub = this.props.bus.getSubscriber<PFDSimvars>();

    const baseClass = 'FontLarge StartAlign';

    sub
      .on('markerBeacon')
      .whenChanged()
      .handle((markerState) => {
        if (markerState === 0) {
          this.classNames.set(`${baseClass} HiddenElement`);
        } else if (markerState === 1) {
          this.classNames.set(`${baseClass} Cyan OuterMarkerBlink`);
          this.markerText.set('OM');
        } else if (markerState === 2) {
          this.classNames.set(`${baseClass} Amber MiddleMarkerBlink`);
          this.markerText.set('MM');
        } else {
          this.classNames.set(`${baseClass} White InnerMarkerBlink`);
          this.markerText.set('IM');
        }
      });
  }

  render(): VNode {
    return (
      <text id="ILSMarkerText" class={this.classNames} x="107" y="133">
        {this.markerText}
      </text>
    );
  }
}

class LsTitle extends DisplayComponent<{ bus: EventBus }> {
  private readonly sub = this.props.bus.getSubscriber<FcuEfisCpBusEvents & PFDSimvars>();

  private readonly fcuEisDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(null);

  private readonly lsButton = this.fcuEisDiscreteWord2.map((word) => word.bitValueOr(14, true));

  private readonly lsTitle = FSComponent.createRef<SVGTextElement>();

  private readonly hasLoc = ConsumerSubject.create(this.sub.on('hasLoc'), false);

  private readonly ilsTitleShown = MappedSubject.create(
    ([hasLoc, lsButton]) => hasLoc && lsButton,
    this.hasLoc,
    this.lsButton,
  );

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    const isFo = getDisplayIndex() === 2;

    this.fcuEisDiscreteWord2.setConsumer(
      this.sub.on(isFo ? 'fcu_efis_r_discrete_word_2' : 'fcu_efis_l_discrete_word_2'),
    );

    // normally the ident and freq should be always displayed when an ILS freq is set, but currently it only show when we have a signal
    this.ilsTitleShown.sub((it) => {
      if (it) {
        this.lsTitle.instance.style.display = 'inline';
      } else {
        this.lsTitle.instance.style.display = 'none';
      }
    });
  }

  render(): VNode {
    return (
      <text class="FontLargest Magenta MiddleAlign" ref={this.lsTitle} x="104" y="126">
        ILS
      </text>
    );
  }
}

class LsReminderIndicator extends DisplayComponent<{ bus: EventBus }> {
  private readonly sub = this.props.bus.getSubscriber<PrimFgBusBaseEvents & FcuEfisCpBusEvents>();

  private readonly fcuEisDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(null);

  private primFgDiscreteWord1 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_1'));

  private primFgDiscreteWord2 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_2'));

  private primFgDiscreteWord4 = Arinc429LocalVarConsumerSubject.create(this.sub.on('prim_fg_discrete_word_4'));

  private readonly lsButton = this.fcuEisDiscreteWord2.map((word) => word.bitValueOr(14, true));

  private readonly approachModeSelected = MappedSubject.create(
    ([primFgDiscreteWord1, primFgDiscreteWord2, primFgDiscreteWord4]) => {
      return (
        primFgDiscreteWord1.bitValueOr(23, false) || // LAND active
        primFgDiscreteWord2.bitValueOr(28, false) || // LAND armed
        primFgDiscreteWord2.bitValueOr(23, false) || // (F)LOC Armed
        primFgDiscreteWord4.bitValueOr(13, false) || // (F)LOC* active
        primFgDiscreteWord4.bitValueOr(14, false) // (F)LOC Active
      ); // TODO Check if LOC or G/S scales are invalid (MMR words)
    },
    this.primFgDiscreteWord1,
    this.primFgDiscreteWord2,
    this.primFgDiscreteWord4,
  );

  private readonly lsReminderVisible = MappedSubject.create(
    ([approachModeSelected, lsPushed]) => {
      return approachModeSelected && !lsPushed; // TODO Check if LOC or G/S scales are invalid (MMR words)
    },
    this.approachModeSelected,
    this.lsButton,
  );

  render(): VNode {
    return (
      <FlashOneHertz bus={this.props.bus} flashDuration={9} visible={this.lsReminderVisible}>
        <text class="FontLargest Amber" x="104.33" y="124.8">
          LS
        </text>
      </FlashOneHertz>
    );
  }
}
