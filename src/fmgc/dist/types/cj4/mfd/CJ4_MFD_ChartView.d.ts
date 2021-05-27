import { NG_Chart } from "../../types/navigraph";
export declare class CJ4_MFD_ChartView extends HTMLElement {
    private readonly _renderCd;
    private _renderTmr;
    private _srcImage;
    private _planeImage;
    private _chart;
    private _canvas;
    private _zoom;
    private _yOffset;
    private _xOffset;
    private _isDirty;
    private readonly STEP_RATE;
    private _chartindexnumber;
    private _chartprocidentifier;
    private _chartinfonogeoref;
    private _isChartLoading;
    private _ngApi;
    private _showDayChart;
    /** Gets a boolean indicating if the view is visible */
    get isVisible(): boolean;
    /** Gets a boolean indicating if the chart is in portrait format */
    get isPortrait(): boolean;
    /** Sets the x offset of the chart view */
    private set xOffset(value);
    /** Gets the x offset of the chart view */
    private get xOffset();
    /** Sets the y offset of the chart view */
    private set yOffset(value);
    /** Gets the y offset of the chart view */
    private get yOffset();
    /** A struct containing different dimension values of the view and chart */
    private readonly _dimensions;
    connectedCallback(): void;
    /** Event thrown when chart image is loaded */
    onSrcImageLoaded(): void;
    /**
     * Loads a chart into the view
     * @param url The url for the chart to load
     * @param chart The chart object
     */
    loadChart(chart?: NG_Chart): Promise<void>;
    update(dTime: number): void;
    /** Draws the green box for panning and zooming */
    private drawRect;
    /** Fits the chart to the canvas size and sets dimension values */
    private scaleImgToFit;
    /** Draws the chart */
    private drawImage;
    private isInsideGeoCoords;
    private isInsidePxCoords;
    onEvent(event: string): boolean;
    show(): void;
    hide(): void;
    private fitCanvasToContainer;
}
