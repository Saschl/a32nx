import { DisplayComponent, FSComponent, NodeReference, Subscribable, VNode } from '@microsoft/msfs-sdk';

/** Scale of the PFD viewBox coordinate system to CSS pixels (768 px / 158.75 units). */
const PX_PER_UNIT = 768 / 158.75;

/** Size of the PFD coordinate system in CSS pixels, used for the inner tape SVGs. */
const PFD_WIDTH_PX = 768;
const PFD_HEIGHT_PX = 211.6 * PX_PER_UNIT;

const px = (units: number) => Math.round(units * PX_PER_UNIT * 1000) / 1000;

/** A rectangle in PFD viewBox units. */
export interface TapeWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VerticalTapeProps {
  displayRange: number;
  valueSpacing: number;
  distanceSpacing: number;
  tapeValue: Subscribable<number>;
  lowerLimit: number;
  upperLimit: number;
  type: 'altitude' | 'speed';
  /** Hides the graduations (e.g. on a failed tape) without stopping the scroll maths. */
  visible: Subscribable<boolean>;
  /** Clip window of the tape, in PFD viewBox units. */
  window: TapeWindow;
  /** Optional grey tape background, in PFD viewBox units. Drawn behind the graduations. */
  background?: TapeWindow;
}

/**
 * The scrolling graduations of a vertical tape.
 *
 * This is an HTML layer rather than part of the main PFD SVG: scrolling an SVG group forces
 * Coherent to re-record every tick and label in it on each frame, whereas moving this layer only
 * repaints the window-sized clip region. The ticks themselves stay in an inner SVG using the
 * unmodified PFD viewBox coordinates, so their geometry, fonts and strokes are unchanged.
 * NOTE: no `will-change` here — Coherent GT does not support it and renders such layers black;
 * plain transforms are fine.
 *
 * The scroll is split in two so that the moving content stays near the window: the tick group is
 * moved to the lowest currently displayed value (an SVG transform, only written when the tape
 * crosses a graduation boundary) and the remainder — always less than the tape height — is applied
 * per frame as a CSS transform on the scroller.
 */
export class VerticalTape extends DisplayComponent<VerticalTapeProps> {
  private readonly windowRef = FSComponent.createRef<HTMLDivElement>();

  private readonly scrollerRef = FSComponent.createRef<HTMLDivElement>();

  private readonly ticksGroupRef = FSComponent.createRef<SVGGElement>();

  private tickRefs: NodeReference<SVGGElement>[] = [];

  private readonly tickElements: { firstPath: SVGPathElement; label: SVGTextElement }[] = [];

  private lastLowestValue = NaN;

  private lastScrollOffset = NaN;

  private buildSpeedGraduationPoints(): VNode[] {
    const numTicks = Math.round((this.props.displayRange * 2) / this.props.valueSpacing);

    const graduationPoints: VNode[] = [];

    for (let i = 0; i < numTicks; i++) {
      const tickRef = FSComponent.createRef<SVGGElement>();
      graduationPoints.push(
        <g ref={tickRef}>
          <path class="NormalStroke White" d="m19.031 80.818h-2.8206" />
          <text class="FontIntermediate MiddleAlign White" x="9.5348943" y="82.936722" />
        </g>,
      );
      this.tickRefs.push(tickRef);
    }
    return graduationPoints;
  }

  private buildAltitudeGraduationPoints(): VNode[] {
    const numTicks = Math.round((this.props.displayRange * 2) / this.props.valueSpacing);

    const graduationPoints: VNode[] = [];

    for (let i = 0; i < numTicks; i++) {
      const tickRef = FSComponent.createRef<SVGGElement>();
      graduationPoints.push(
        <g ref={tickRef}>
          <path class="NormalStroke White HiddenElement" d="m115.79 81.889 1.3316-1.0783-1.3316-1.0783" />
          <path class="NormalStroke White" d="m130.85 80.819h-2.0147" />
          <text class="FontMedium MiddleAlign White" x="123.28826" y="82.64006" />
        </g>,
      );
      this.tickRefs.push(tickRef);
    }
    return graduationPoints;
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    for (const ref of this.tickRefs) {
      this.tickElements.push({
        firstPath: ref.instance.getElementsByTagName('path')[0],
        label: ref.instance.getElementsByTagName('text')[0],
      });
    }

    this.props.visible.sub((visible) => {
      this.windowRef.instance.style.display = visible ? 'block' : 'none';
    }, true);

    this.props.tapeValue.sub((newValue) => {
      const multiplier = 100;
      const currentValueAtPrecision = Math.round(newValue * multiplier) / multiplier;
      const clampedValue = Math.max(
        Math.min(currentValueAtPrecision, this.props.upperLimit ?? Infinity),
        this.props.lowerLimit ?? -Infinity,
      );

      let lowestValue = Math.max(
        Math.round((clampedValue - this.props.displayRange) / this.props.valueSpacing) * this.props.valueSpacing,
        this.props.lowerLimit,
      );
      if (lowestValue < currentValueAtPrecision - this.props.displayRange) {
        lowestValue += this.props.valueSpacing;
      }

      // Only re-lay out the ticks when the visible window crosses a graduation boundary
      if (lowestValue !== this.lastLowestValue) {
        this.lastLowestValue = lowestValue;

        for (let i = 0; i < this.tickElements.length - 1; i++) {
          const elementValue = lowestValue + i * this.props.valueSpacing;
          if (elementValue <= (this.props.upperLimit ?? Infinity)) {
            const { firstPath, label } = this.tickElements[i];
            const offset = (-elementValue * this.props.distanceSpacing) / this.props.valueSpacing;
            this.tickRefs[i].instance.setAttribute('transform', `translate(0 ${offset})`);

            let text = '';
            if (this.props.type === 'speed') {
              if (elementValue % 20 === 0) {
                text = Math.abs(elementValue).toString().padStart(3, '0');
              }
            } else if (this.props.type === 'altitude') {
              if (elementValue % 500 === 0) {
                text = (Math.abs(elementValue) / 100).toString().padStart(3, '0');
                firstPath.classList.remove('HiddenElement');
              } else {
                firstPath.classList.add('HiddenElement');
              }
            }

            if (label.textContent !== text) {
              label.textContent = text;
            }
          }
        }

        // Keep the ticks near the window: this cancels the absolute offsets the ticks are
        // positioned at above, so the residual scroll below stays small.
        const groupOffset = (lowestValue * this.props.distanceSpacing) / this.props.valueSpacing;
        this.ticksGroupRef.instance.setAttribute('transform', `translate(0 ${groupOffset})`);
      }

      // The residual scroll, always less than the tape height, is what moves every frame
      const scrollOffset =
        Math.round((((clampedValue - lowestValue) * this.props.distanceSpacing) / this.props.valueSpacing) * 1000) /
        1000;
      if (scrollOffset !== this.lastScrollOffset) {
        this.lastScrollOffset = scrollOffset;
        this.scrollerRef.instance.style.transform = `translate3d(0px, ${px(scrollOffset)}px, 0px)`;
      }
    }, true);
  }

  render(): VNode {
    const w = this.props.window;
    const bg = this.props.background;

    return (
      <div
        ref={this.windowRef}
        class="pfd-tape-window"
        style={`left: ${px(w.x)}px; top: ${px(w.y)}px; width: ${px(w.width)}px; height: ${px(w.height)}px;`}
      >
        {bg !== undefined ? (
          <div
            class="pfd-tape-background"
            style={
              `left: ${px(bg.x - w.x)}px; top: ${px(bg.y - w.y)}px; ` +
              `width: ${px(bg.width)}px; height: ${px(bg.height)}px;`
            }
          />
        ) : null}
        <div ref={this.scrollerRef} class="pfd-tape-scroller" style={`left: ${px(-w.x)}px; top: ${px(-w.y)}px;`}>
          <svg
            class="pfd-tape-svg"
            version="1.1"
            viewBox="0 0 158.75 211.6"
            width={PFD_WIDTH_PX}
            height={PFD_HEIGHT_PX}
            xmlns="http://www.w3.org/2000/svg"
          >
            <g ref={this.ticksGroupRef}>
              {this.props.type === 'altitude' && this.buildAltitudeGraduationPoints()}
              {this.props.type === 'speed' && this.buildSpeedGraduationPoints()}
            </g>
          </svg>
        </div>
      </div>
    );
  }
}

interface TapeScrollGroupProps {
  valueSpacing: number;
  distanceSpacing: number;
  tapeValue: Subscribable<number>;
  lowerLimit: number;
  upperLimit: number;
}

/**
 * An SVG group that scrolls with a vertical tape, for elements that cannot live in the tape's
 * HTML graduation layer — the speed bugs overhang the tape window and use shapes (outlined
 * circles, filled markers) that SVG draws natively.
 */
export class TapeScrollGroup extends DisplayComponent<TapeScrollGroupProps> {
  private readonly refElement = FSComponent.createRef<SVGGElement>();

  private lastClampedValue = NaN;

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    this.props.tapeValue.sub((newValue) => {
      const currentValueAtPrecision = Math.round(newValue * 100) / 100;
      const clampedValue = Math.max(
        Math.min(currentValueAtPrecision, this.props.upperLimit ?? Infinity),
        this.props.lowerLimit ?? -Infinity,
      );

      if (clampedValue !== this.lastClampedValue) {
        this.lastClampedValue = clampedValue;
        this.refElement.instance.style.transform = `translate3d(0px, ${(clampedValue * this.props.distanceSpacing) / this.props.valueSpacing}px, 0px)`;
      }
    }, true);
  }

  render(): VNode {
    return <g ref={this.refElement}>{this.props.children}</g>;
  }
}
