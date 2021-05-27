import { OperatingMessage } from "../messages/OperatingMessage";
/** Enumeration for CJ4 FMS Messages */
export declare enum FMS_MESSAGE_ID {
    INIT_POS = 0,
    NO_FPLN = 1,
    FPLN_DISCO = 2,
    CHK_SPD = 3,
    CHK_ALT_SEL = 4,
    HOLD = 5,
    TOD = 6,
    TERM = 7,
    TERM_LPV = 8,
    APPR = 9,
    APPR_LPV = 10,
    SEQ_INHIBIT = 11,
    LOC_WILL_BE_TUNED = 12,
    CHECK_LOC_TUNING = 13
}
/** A class that contains the CJ4 message definitions */
export declare class CJ4_MessageDefinitions {
    private static _definitions;
    /** Gets the message definitions */
    static get definitions(): Map<FMS_MESSAGE_ID, OperatingMessage>;
}
