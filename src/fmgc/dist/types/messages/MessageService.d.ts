import { FMS_MESSAGE_ID } from "../cj4/CJ4_MessageDefinitions";
import { IMessageReceiver } from "./IMessageReceiver";
import { MESSAGE_TARGET } from "./MessageDefinition";
export declare class MessageService {
    private _activeMsgs;
    private _receivers;
    private static _instance;
    static getInstance(): MessageService;
    private constructor();
    /**
     * Posts messages to the targets defined in the message definition
     * @param msgkey The message identifier
     * @param exitHandler A function that returns true when the msg should not be shown anymore
     * @param blinkHandler A function that returns a boolean indicating if the message should blink
     */
    post(msgkey: FMS_MESSAGE_ID, exitHandler: () => boolean, blinkHandler?: () => boolean): void;
    /**
     * Clears a message from all targets
     * @param msgkey The message identifier
     */
    clear(msgkey: FMS_MESSAGE_ID): void;
    /** Update function which calls the exitHandler function and clears messages that have to go */
    update(): void;
    /**
     * Registers a receiver implementation to the target display
     * @param target The target display
     * @param receiver The receiver
     */
    registerReceiver(target: MESSAGE_TARGET, receiver: IMessageReceiver): void;
}
/** Just a wrapper */
export declare class MessageConditionChecks {
    private _exitHandler;
    get exitHandler(): () => boolean;
    set exitHandler(v: () => boolean);
    constructor(_exitHandler: () => boolean);
}
