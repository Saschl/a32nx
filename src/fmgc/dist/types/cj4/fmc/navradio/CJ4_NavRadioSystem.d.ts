/**
 * The CJ4 Nav Radio system.
 */
export declare class CJ4_NavRadioSystem {
    /** The states of the nav radios. */
    radioStates: CJ4NavRadioState[];
    presets: number[];
    /** Whether or not a nearest VOR search is pending. */
    private searchPending;
    constructor();
    /**
     * Initializes the radio system.
     */
    initialize(): void;
    /**
     * Updates the nav radio system.
     */
    update(): void;
    /**
     * Sets a nav radio preset.
     * @param index The index of the preset to set.
     * @param frequency The frequency to set the preset to.
     */
    setPreset(index: number, frequency: number): void;
    /**
     * Parses an input frequency string to return a valid nav frequency.
     * @param value The value to parse.
     * @returns The nav frequency, if valid.
     */
    parseFrequencyInput(value: string): number;
    /**
     * Updates the auto-tuning of the nav radios.
     */
    private updateAutoTuning;
}
export declare enum NavRadioMode {
    Manual = "MAN",
    Auto = "AUTO"
}
/**
 * The state of a single NAV radio.
 */
export declare class CJ4NavRadioState {
    /** The index of the radio. */
    radioIndex: 1 | 2;
    /** The current nav radio mode. */
    mode: NavRadioMode;
    /** The current nav radio frequency. */
    frequency: number;
    /** The last time the nav radio was auto-tuned. */
    lastAutoTuned: number;
    /**
     * Creates an instance of CJ4NavRadioState.
     * @param radioIndex The index of the radio.
     */
    constructor(radioIndex: 1 | 2);
    /**
     * Initializes the radio state.
     */
    initialize(): void;
    /**
     * Sets a manual nav frequency.
     * @param frequency The frequency to set.
     */
    setManualFrequency(frequency: number): void;
    /**
     * Sets an automatically set nav frequency.
     * @param frequency The frequency to set.
     */
    setAutomaticFrequency(frequency: number): void;
}
