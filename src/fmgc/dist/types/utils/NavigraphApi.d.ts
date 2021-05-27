import * as NgApi from '../types/navigraph';
import { RequestResult } from './WebRequest';
export declare class NavigraphApi {
    readonly RFRSH_TOKEN_KEY = "WT_NG_REFRESH_TOKEN";
    readonly ACC_TOKEN_KEY = "WT_NG_ACC_TOKEN";
    private _refreshToken;
    private _chartListCache;
    private _chartCacheTimestamp;
    private _accessTokenTimestamp;
    /** Gets a boolean indicating if the navigraph account is linked */
    get isAccountLinked(): boolean;
    /** Sets the refresh token */
    set refreshToken(val: string);
    get refreshToken(): string;
    /** Returns a boolean indicating if a access token is known */
    get hasAccessToken(): boolean;
    /** Sets the access token */
    set accessToken(val: string);
    /** Gets the access token */
    get accessToken(): string;
    /**
     * Checks if the access token is still good or starts the link account process
     */
    validateToken(): Promise<void>;
    /**
     * Refreshes the access token using the refresh token
     */
    refreshAccessToken(): Promise<void>;
    /**
     * Gets a list of charts for the given ICAO
     * @param icao The ICAO of the airport to get the charts from
     */
    getChartsList(icao: string): Promise<NgApi.NG_Charts | undefined>;
    private invalidateChartCache;
    /**
     * Executes the navigraph account linking process
     */
    linkAccount(): Promise<boolean>;
    /** Gets the signed png url of the requested chart */
    getChartPngUrl(chart: NgApi.NG_Chart, dayChart?: boolean): Promise<string>;
    /**
     * Used to encapsulate requests to navigraph
     * @param path The url the request points to
     * @param method "GET" or "POST"
     * @param form A map of data to send in the request body
     * @param auth A boolean indicating if the auth token should be used for this request
     */
    sendRequest(path: string, method: 'get' | 'post', form?: Map<string, string>, auth?: boolean): Promise<RequestResult>;
    /**
     * Artificial delay
     * @param ms Time to delay
     */
    delay(ms: number): Promise<void>;
    private readonly placeholdertext1;
    private readonly placeholdertext2;
    private readonly placeholdertext3;
    private readonly placeholdertext4;
}
