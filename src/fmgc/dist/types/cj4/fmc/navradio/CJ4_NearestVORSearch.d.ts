/**
 * A class that handles searching for nearest VOR stations.
 */
export declare class CJ4_NearestVORSearch {
    /**
     * Searches for the nearest VOR stations to the current aircraft position.
     * @param distance The maximum distance in NM to search.
     * @param maxItems The maximum number of VOR stations to return.
     */
    static searchNearest(distance: number, maxItems: number): Promise<VORStation[]>;
}
/** A VOR station. */
export interface VORStation {
    icao: string;
    frequency: number;
    distance: number;
}
