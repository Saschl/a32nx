import { IMessageReceiver } from "../../messages/IMessageReceiver";
import { Message } from "../../messages/Message";
import { MESSAGE_LEVEL, MESSAGE_TARGET } from "../../messages/MessageDefinition";
import { FMS_MESSAGE_ID } from "../CJ4_MessageDefinitions";
/**
 * The receiver for messages shown in the FMC
 */
export declare class CJ4_FMC_MessageReceiver implements IMessageReceiver {
    private _activeMsgs;
    process(id: FMS_MESSAGE_ID, text: string, level: MESSAGE_LEVEL, weight: number, target: MESSAGE_TARGET): void;
    clear(id: FMS_MESSAGE_ID): void;
    /** Returns a boolean indicating if there are active messages */
    hasMsg(): boolean;
    /** Returns the string content of the highest priority message */
    getMsgText(): string;
    /** Returns all active messages */
    getActiveMsgs(): Message[];
}
