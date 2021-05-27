import { NG_Chart } from "../../types/navigraph";
/** Class for managing the view portion of showing the charts pages on the MFD */
export declare class CJ4_MFD_ChartsPopup extends HTMLElement {
    private _mode;
    private _tableContainer;
    private _chartSelectCallback;
    private _views;
    private _overlayHeader;
    private _ngApi;
    /**
     * Gets a boolean indicating if the view is visible
     */
    get isVisible(): boolean;
    connectedCallback(chartSelectCallback: (chart: NG_Chart) => void): void;
    /** Is getting called when the chart menu is to be opened */
    private openChartMenuCallback;
    /** Is getting called when a chart was selected from the chart selection menu */
    private multiChartSelectCallback;
    update(): Promise<void>;
    onEvent(event: string): boolean;
    /** Scroll to previous charts in the list and select it */
    selectPrevChart(): void;
    /** Scroll to next chart in the list and select it */
    selectNextChart(): void;
    /** Show the view */
    show(): void;
    /** Hide the view */
    hide(): void;
}
