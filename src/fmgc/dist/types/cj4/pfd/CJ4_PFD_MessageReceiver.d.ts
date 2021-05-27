import { IMessageReceiver } from "../../messages/IMessageReceiver";
import { MESSAGE_LEVEL, MESSAGE_TARGET } from "../../messages/MessageDefinition";
import { FMS_MESSAGE_ID } from "../CJ4_MessageDefinitions";
export declare class CJ4_PFD_MessageReceiver implements IMessageReceiver {
    static PFD_MSGS_KEY: string;
    private _activeMsgs;
    constructor();
    process(id: FMS_MESSAGE_ID, text: string, level: MESSAGE_LEVEL, weight: number, target: MESSAGE_TARGET, blinkHandler?: () => boolean): void;
    clear(id: FMS_MESSAGE_ID): void;
    /** Update function called by the FMS to update and send messages to the pfd */
    update(): void;
    /**
     * Filters messages by target and returns the one with the highes priority
     * @param msgs Array of messages
     * @param target The display target
     */
    private pickHighPriorityMsg;
    /** Returns a boolean indicating if there are active messages */
    private hasMsg;
}
