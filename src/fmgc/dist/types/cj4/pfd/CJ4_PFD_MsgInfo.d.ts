export declare class CJ4_PFD_MsgInfo extends HTMLElement {
    private _botLeftElement;
    private _botRightElement;
    private _topElement;
    private readonly UPDATE_RATE;
    private _elapsedTime;
    private _fmcMsgTimestamp;
    private _lastFmcMsgLevel;
    private _botLeftText;
    private set botLeftText(value);
    private _botRightText;
    private set botRightText(value);
    private _topText;
    private set topText(value);
    constructor();
    connectedCallback(): void;
    /** Update function called by the display */
    update(_dTime: number): void;
    /**
     * Returns a formatted string for message display
     * @param msg The message object
     */
    getMsgString(msg: any): string;
}
