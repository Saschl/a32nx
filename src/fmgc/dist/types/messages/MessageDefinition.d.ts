export declare class MessageDefinition {
    private _text;
    private _target;
    get text(): string;
    get target(): MESSAGE_TARGET;
    constructor(_text: string, _target: MESSAGE_TARGET);
}
/** An enumeration for CJ4 message target displays */
export declare enum MESSAGE_TARGET {
    FMC = 0,
    PFD_TOP = 1,
    PFD_BOT = 2,
    MAP_MID = 3,
    MFD_TOP = 4
}
/**
 * Enumeration of message levels
 */
export declare enum MESSAGE_LEVEL {
    White = 0,
    Yellow = 1
}
