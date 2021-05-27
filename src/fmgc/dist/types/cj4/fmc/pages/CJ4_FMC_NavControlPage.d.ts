import { CJ4_FMC_Page } from "../CJ4_FMC_Page";
import { CJ4_NavRadioSystem } from "../navradio/CJ4_NavRadioSystem";
/**
 * The NAV CONTROL FMC page.
 */
export declare class CJ4_FMC_NavControlPage extends CJ4_FMC_Page {
    /** An instance of the nav radio system. */
    radioSystem: CJ4_NavRadioSystem;
    /** The radio index for the page. */
    radioIndex: number;
    /** An instance of the template renderer. */
    templateRenderer: WT_FMC_Renderer;
    /** The current page number. */
    currentPageNumber: number;
    /**
     * Creates an instance of the CJ4_FMC_NavControlPage.
     * @param fmc The FMC to use with this instance.
     * @param radioIndex The index of the radio for the page.
     */
    constructor(fmc: CJ4_FMC, radioIndex: number);
    /**
     * Whether or not the page has an automatic refresh.
     */
    hasRefresh(): boolean;
    /**
     * Updates the page.
     */
    update(): void;
    /**
     * Renders the nav control page.
     */
    render(): void;
    /**
     * Gets the display value for a given nav radio preset.
     * @param preset The preset index to display.
     * @returns The preset frequency as a string.
     */
    private displayPreset;
    /**
     * Binds input events for the nav control page.
     */
    bindEvents(): void;
    /**
     * Binds the buttons for the preset LSKs.
     * @param totalPresets The total number of presets on the page.
     * @param startLSK The starting LSK for the preset bindings.
     * @param startPreset The starting index for the presets.
     */
    private bindPresets;
    /**
     * Handles when a frequency button is pressed on the page.
     * @param getter A function that gets the frequency value to copy to the scratchpad.
     * @param setter A function that sets the frequency value into the radio state from the parsed input.
     */
    private handleFreqPressed;
}
