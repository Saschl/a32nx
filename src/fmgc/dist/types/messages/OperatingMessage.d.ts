import { MessageDefinition, MESSAGE_LEVEL } from "./MessageDefinition";
export declare class OperatingMessage {
    private _msgDefs;
    private _level;
    private _weight;
    get msgDefs(): MessageDefinition[];
    get level(): MESSAGE_LEVEL;
    get weight(): number;
    constructor(_msgDefs: MessageDefinition[], _level: MESSAGE_LEVEL, _weight: number);
}
