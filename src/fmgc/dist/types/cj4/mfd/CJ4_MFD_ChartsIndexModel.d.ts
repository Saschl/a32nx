import { NG_Chart } from "../../types/navigraph";
import { NavigraphApi } from "../../utils/NavigraphApi";
interface IChartIndex {
    Origin: {
        Airport: NG_Chart | undefined;
        Departure: NG_Chart | undefined;
        Arrival: NG_Chart | undefined;
        Approach: NG_Chart | undefined;
    };
    Destination: {
        Arrival: NG_Chart | undefined;
        Approach: NG_Chart | undefined;
        Airport: NG_Chart | undefined;
        Departure: NG_Chart | undefined;
    };
}
export declare class CJ4_MFD_ChartsIndexModel {
    private _api;
    private _fpm;
    private _fpChecksum;
    private _chartsIndex;
    get chartsIndex(): IChartIndex;
    private _origin;
    get origin(): string;
    private _destination;
    get destination(): string;
    constructor(ngApi: NavigraphApi);
    /**
   * Retrieves and updates the chart index
   */
    updateData(forceUpdate?: boolean): Promise<boolean>;
    /** Gets a chart object by index */
    getChartAtIndex(index: number): NG_Chart;
    setChartAtIndex(chart: NG_Chart, _selectedIndex: number): void;
    /** Flattens the chart index to an array */
    getFlatChartIndex(): Array<NG_Chart>;
    /** Flattens the chart index keys to an array */
    getFlatChartKeys(): Array<string>;
    /**
     * Resets the charts in the index
     */
    private resetChartsIndex;
    /**
     * Formats the approach name to be compatible with Navigraph.
     * @param name The msfs name of the approach
     */
    private formatApproachName;
    /**
    * Finds a chart in the array using the predicate.
    * @param predicate A predicate used to find a chart
    * @param charts The array of charts to search in
    */
    private findChartInArray;
}
export {};
