export declare abstract class CJ4_FMC_Page {
    protected _fmc: CJ4_FMC;
    private static _instance;
    private _isDirty;
    refreshInterval: number;
    /** Sets a boolean indicating if the page should be invalidated */
    set isDirty(v: boolean);
    constructor(_fmc: CJ4_FMC);
    /** Returns a boolean indicating if the page should run a timer to call update() */
    abstract hasRefresh(): boolean;
    /** Updates and evaluates data looking for changes
      * Should set {@link CJ4_FMC_Page#isDirty} to true when data has changed.
    */
    abstract update(): void;
    /**
     * Runs the update() method of the page implementation and calls invalidate() when needed
     */
    updateCheck(): void;
    /** Renders the page */
    abstract render(): void;
    /** Rerenders the page and reinitializes event bindings */
    protected invalidate(): void;
    abstract bindEvents(): void;
}
