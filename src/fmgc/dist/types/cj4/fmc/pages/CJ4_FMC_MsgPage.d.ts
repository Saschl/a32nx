import { CJ4_FMC_Page } from "../CJ4_FMC_Page";
export declare class CJ4_FMC_MsgPage extends CJ4_FMC_Page {
    private _msgsChecksum;
    private _msgs;
    private _currentPage;
    private _pageCount;
    private _offset;
    set currentPage(value: number);
    private gotoNextPage;
    private gotoPrevPage;
    hasRefresh(): boolean;
    update(force?: boolean): void;
    render(): void;
    bindEvents(): void;
    /** Gets the checksum of the current active message ids */
    private getMsgsChecksum;
}
