import { FSComponent, ConsumerSubject, DisplayComponent, EventBus, VNode, Subscribable } from '@microsoft/msfs-sdk';

import { FmsSymbolsData } from '@flybywiresim/navigation-display';
import { MathUtils } from '@flybywiresim/fbw-sdk';

export interface VerticalCanvasMapProps {
  bus: EventBus;

  x: number;

  y: number;

  width: number;

  height: number;

  ndRange: Subscribable<number>;
}

export class VerticalCanvasMap extends DisplayComponent<VerticalCanvasMapProps> {
  private readonly canvasRef = FSComponent.createRef<HTMLCanvasElement>();

  private ctx: CanvasRenderingContext2D | null = null;

  private readonly subscriber = this.props.bus.getSubscriber<FmsSymbolsData>();

  private readonly verticalProfile = ConsumerSubject.create(this.subscriber.on('verticalProfile'), null);

  onAfterRender(node: VNode) {
    super.onAfterRender(node);

    this.ctx = this.canvasRef.instance.getContext('2d');

    this.props.ndRange.sub(() => this.update());
    this.verticalProfile.sub(() => this.update());
  }

  public update(): void {
    this.paint();
  }

  private paint(): void {
    if (!this.ctx) {
      return;
    }

    this.ctx.clearRect(0, 0, this.props.width, this.props.height);

    const profile = this.verticalProfile.get();

    if (!profile) {
      return;
    }

    const verticalExtentFT = 40_000;
    const horizontalExtentNM = MathUtils.clamp(this.props.ndRange.get(), 0, 160);

    this.ctx.strokeStyle = `rgb(0, 255, 0)`;
    this.ctx.lineWidth = 1.75;

    this.ctx.beginPath();
    this.ctx.moveTo(0, this.props.height);

    for (const vector of profile.vectors) {
      const endX = this.props.width * (vector.endDistance / horizontalExtentNM);
      const endY = this.props.height - this.props.height * (vector.endAltitude / verticalExtentFT);

      this.ctx.lineTo(endX, endY);
    }

    this.ctx.stroke();
  }

  render(): VNode | null {
    return (
      <canvas
        ref={this.canvasRef}
        style={{ position: 'absolute', top: `${this.props.y}px`, left: `${this.props.x}px` }}
        width={this.props.width}
        height={this.props.height}
      />
    );
  }
}
