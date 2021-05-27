/**
 * An annunciation display slot on the PFD FGS display.
 */
export declare class CJ4_FGSDisplaySlot {
    private element;
    private shouldFlash;
    /** The current FGS slot display value. */
    private currentDisplayValue;
    /** Whether or not the FGS mode is currently failed. */
    private currentlyIsFailed;
    /** The current timeout to cancel value change blinking. */
    private blinkTimeout;
    /** The span that contains the display value. */
    private valueSpan;
    /**
     * Creates an instance of a CJ4_FGSDisplaySlot.
     * @param element The underlying HTML element.
     * @param shouldFlash Whether or not the element should flash on change.
     */
    constructor(element: HTMLElement, shouldFlash?: boolean);
    /**
     * Sets the FGS slot display value.
     * @param value The value to display.
     */
    setDisplayValue(value: string): void;
    /**
     * Sets the FGS slot failure strikethrough.
     * @param isFailed
     */
    setFailed(isFailed: boolean): void;
}
