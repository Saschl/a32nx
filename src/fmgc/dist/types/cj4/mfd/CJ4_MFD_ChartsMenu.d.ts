import { NG_Chart } from "../../types/navigraph";
import { NavigraphApi } from "../../utils/NavigraphApi";
import { CHART_TYPE } from "../../utils/NavigraphChartFilter";
import { ICJ4_MFD_ChartsPopupPage } from "./ICJ4_MFD_ChartsPopupPage";
export declare class CJ4_MFD_ChartsMenu implements ICJ4_MFD_ChartsPopupPage {
    private _container;
    private _selectCallback;
    private readonly PAGE_SIZE;
    private _model;
    private _selectedIndex;
    private _lastChartCount;
    private _currentPage;
    private _totalPages;
    private _chartInitPromise;
    constructor(icao: string, type: CHART_TYPE, ngApi: NavigraphApi, _container: HTMLElement, _selectCallback: (chart: NG_Chart) => void);
    update(): Promise<void>;
    onEvent(event: string): boolean;
    private render;
    /** Selects a charts and calls back to the view */
    private selectChart;
    private menuScroll;
    /** Sets the style on the selected row */
    private renderselect;
}
