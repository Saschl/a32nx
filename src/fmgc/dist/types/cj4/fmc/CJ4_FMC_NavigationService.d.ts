import { CJ4_FMC_Page } from "./CJ4_FMC_Page";
/** A class for managing and showing navigation between FMC pages */
export declare class CJ4_FMC_NavigationService {
    private _fmc;
    private _currentPage;
    constructor(_fmc: CJ4_FMC);
    /** Constructs and shows a page given the type as argument */
    showPage<T extends CJ4_FMC_Page>(page: new (fmc: CJ4_FMC, ...args: any[]) => T, ...args: any[]): void;
    /** Registers the refresh loop  */
    private registerRefresh;
}
