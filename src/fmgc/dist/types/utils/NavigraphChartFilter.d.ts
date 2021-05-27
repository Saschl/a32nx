import { NG_Chart, NG_Charts } from "../types/navigraph";
export declare enum CHART_TYPE {
    AIRPORT = 0,
    DEPARTURE = 1,
    ARRIVAL = 2,
    APPROACH = 3,
    AIRSPACE = 4,
    NOISE = 5
}
export declare class NavigraphChartFilter {
    static getAirspace(charts: NG_Charts): NG_Chart[];
    static getAirport(charts: NG_Charts): NG_Chart[];
    static getDeparture(charts: NG_Charts): NG_Chart[];
    static getArrival(charts: NG_Charts): NG_Chart[];
    static getApproach(charts: NG_Charts): NG_Chart[];
    static getApproachPrecision(charts: NG_Charts): NG_Chart[];
    static getApproachNonPrecision(charts: NG_Charts): NG_Chart[];
    /**
   * Finds a chart in the array using the predicate.
   * @param predicate A predicate used to find a chart
   * @param charts The array of charts to search in
   */
    private static findChartInArray;
}
