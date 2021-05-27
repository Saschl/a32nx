import { NG_Chart } from "../../types/navigraph";
import { NavigraphApi } from "../../utils/NavigraphApi";
import { CHART_TYPE } from "../../utils/NavigraphChartFilter";
import { ICJ4_MFD_ChartsPopupPage } from "./ICJ4_MFD_ChartsPopupPage";
export declare class CJ4_MFD_ChartsIndex implements ICJ4_MFD_ChartsPopupPage {
    private _container;
    private _chartSelectCallback;
    private _multiChartCallback;
    private _model;
    private _selectedIndex;
    constructor(_container: HTMLElement, ngApi: NavigraphApi, _chartSelectCallback: (chart: NG_Chart) => void, _multiChartCallback: (icao: string, type: CHART_TYPE) => void);
    /**
     * Retrieves and updates the chart index
     */
    update(force?: boolean): Promise<void>;
    onEvent(event: string): boolean;
    /** Set a chart at current selected index in the list of charts */
    setChart(chart: NG_Chart): void;
    /** Requests to open the chart selection menu */
    private callChartMenu;
    /** Sends the currently selected chart back to the callback delegates. */
    selectChart(): Promise<void>;
    /** Scroll to previous charts in the list and select it */
    selectPrevChart(): void;
    /** Scroll to next chart in the list and select it */
    selectNextChart(): void;
    /** Sets the style on the selected row */
    private renderselect;
    /** Handling to scroll through the menu */
    private menuScroll;
    /** Renders the chart index */
    private render;
    private renderFmsHead;
    /**
     * Renders a section of the chart index
     * @param caption The caption of the index section
     * @param data An object containing the charts.
     */
    private renderIndexSection;
}
