// Copyright (c) 2021-2023 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { DisplayComponent, FSComponent, NodeReference, Subscribable, VNode } from '@microsoft/msfs-sdk';

interface VerticalTapeProps {
  displayRange: number;
  valueSpacing: number;
  distanceSpacing: number;
  tapeValue: Subscribable<number>;
  lowerLimit: number;
  upperLimit: number;
  type: 'altitude' | 'speed';
}

export class VerticalTape extends DisplayComponent<VerticalTapeProps> {
  private refElement = FSComponent.createRef<SVGGElement>();

  private tickRefs: NodeReference<SVGGElement>[] = [];

  // cached per-tick child elements, resolved once after render; getElementsByTagName on every
  // frame walks the subtree and allocates
  private tickArrows: (SVGPathElement | undefined)[] = [];

  private tickTexts: SVGTextElement[] = [];

  private lastLowestValue = NaN;

  private lastRootValue = NaN;

  private buildSpeedGraduationPoints(): NodeReference<SVGGElement>[] {
    const numTicks = Math.round((this.props.displayRange * 2) / this.props.valueSpacing);

    const clampedValue = Math.max(Math.min(this.props.tapeValue.get(), this.props.upperLimit), this.props.lowerLimit);

    let lowestValue = Math.max(
      Math.round((clampedValue - this.props.displayRange) / this.props.valueSpacing) * this.props.valueSpacing,
      this.props.lowerLimit,
    );
    if (lowestValue < this.props.tapeValue.get() - this.props.displayRange) {
      lowestValue += this.props.valueSpacing;
    }

    const graduationPoints = [];

    for (let i = 0; i < numTicks; i++) {
      const elementValue = lowestValue + i * this.props.valueSpacing;
      if (elementValue <= (this.props.upperLimit ?? Infinity)) {
        const offset = (-elementValue * this.props.distanceSpacing) / this.props.valueSpacing;
        const element = { elementValue, offset };
        if (element) {
          let text = '';
          if (elementValue % 20 === 0) {
            text = Math.abs(elementValue).toString().padStart(3, '0');
          }

          const tickRef = FSComponent.createRef<SVGGElement>();
          graduationPoints.push(
            <g ref={tickRef} style={`transform: translate3d(0px, ${offset}px, 0px)`}>
              <path class="NormalStroke White" d="m19.031 80.818h-2.8206" />
              <text class="FontMedium MiddleAlign White" x="8.0348943" y="82.936722">
                {text}
              </text>
            </g>,
          );
          this.tickRefs.push(tickRef);
        }
      }
    }
    return graduationPoints;
  }

  private buildAltitudeGraduationPoints(): NodeReference<SVGGElement>[] {
    const numTicks = Math.round((this.props.displayRange * 2) / this.props.valueSpacing);

    const clampedValue = Math.max(Math.min(this.props.tapeValue.get(), this.props.upperLimit), this.props.lowerLimit);

    let lowestValue = Math.max(
      Math.round((clampedValue - this.props.displayRange) / this.props.valueSpacing) * this.props.valueSpacing,
      this.props.lowerLimit,
    );
    if (lowestValue < this.props.tapeValue.get() - this.props.displayRange) {
      lowestValue += this.props.valueSpacing;
    }

    const graduationPoints = [];

    for (let i = 0; i < numTicks; i++) {
      const elementValue = lowestValue + i * this.props.valueSpacing;
      if (elementValue <= (this.props.upperLimit ?? Infinity)) {
        const offset = (-elementValue * this.props.distanceSpacing) / this.props.valueSpacing;
        const element = { elementValue, offset };
        if (element) {
          let text = '';
          if (elementValue % 500 === 0) {
            text = (Math.abs(elementValue) / 100).toString().padStart(3, '0');
          }
          const tickRef = FSComponent.createRef<SVGGElement>();

          graduationPoints.push(
            <g ref={tickRef} style={`transform: translate3d(0px, ${offset}px, 0px)`}>
              <path class="NormalStroke White HiddenElement" d="m115.79 81.889 1.3316-1.0783-1.3316-1.0783" />
              <path class="NormalStroke White" d="m130.85 80.819h-2.0147" />
              <text class="FontMedium MiddleAlign White" x="123.28826" y="82.64006">
                {text}
              </text>
            </g>,
          );
          this.tickRefs.push(tickRef);
        }
      }
    }
    return graduationPoints;
  }

  // The ticks are laid out at absolute tape offsets, so they only need to move when the visible
  // window crosses a graduation boundary and lowestValue changes
  private relayoutTicks(lowestValue: number) {
    for (let i = 0; i < this.tickRefs.length - 1; i++) {
      const elementValue = lowestValue + i * this.props.valueSpacing;
      if (elementValue <= (this.props.upperLimit ?? Infinity)) {
        const offset = (-elementValue * this.props.distanceSpacing) / this.props.valueSpacing;
        this.tickRefs[i].instance.style.transform = `translate3d(0px, ${offset}px, 0px)`;

        let text = '';
        if (this.props.type === 'speed') {
          if (elementValue % 20 === 0) {
            text = Math.abs(elementValue).toString().padStart(3, '0');
          }
        } else if (this.props.type === 'altitude') {
          if (elementValue % 500 === 0) {
            text = (Math.abs(elementValue) / 100).toString().padStart(3, '0');
            this.tickArrows[i]?.classList.remove('HiddenElement');
          } else {
            this.tickArrows[i]?.classList.add('HiddenElement');
          }
        }

        if (this.tickTexts[i].textContent !== text) {
          this.tickTexts[i].textContent = text;
        }
      }
    }
  }

  onAfterRender(node: VNode): void {
    super.onAfterRender(node);

    for (const tickRef of this.tickRefs) {
      this.tickArrows.push(
        this.props.type === 'altitude' ? tickRef.instance.getElementsByTagName('path')[0] : undefined,
      );
      this.tickTexts.push(tickRef.instance.getElementsByTagName('text')[0]);
    }

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

      if (lowestValue !== this.lastLowestValue) {
        this.lastLowestValue = lowestValue;
        this.relayoutTicks(lowestValue);
      }

      if (clampedValue !== this.lastRootValue) {
        this.lastRootValue = clampedValue;
        this.refElement.instance.style.transform = `translate3d(0px, ${(clampedValue * this.props.distanceSpacing) / this.props.valueSpacing}px, 0px)`;
      }
    }, true);
  }

  render(): VNode {
    return (
      <g ref={this.refElement}>
        {this.props.type === 'altitude' && this.buildAltitudeGraduationPoints()}
        {this.props.type === 'speed' && this.buildSpeedGraduationPoints()}
        {this.props.children}
      </g>
    );
  }
}
