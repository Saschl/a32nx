import { NG_Chart } from "../../types/navigraph";
import { NavigraphApi } from "../../utils/NavigraphApi";
import { CHART_TYPE } from "../../utils/NavigraphChartFilter";
export declare class CJ4_MFD_ChartsMenuModel {
    private _api;
    private _type;
    private _icao;
    private _charts;
    get icao(): string;
    get type(): CHART_TYPE;
    get charts(): NG_Chart[];
    constructor(icao: string, type: CHART_TYPE, ngApi: NavigraphApi);
    init(): Promise<void>;
}
