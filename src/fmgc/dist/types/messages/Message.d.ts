import { FMS_MESSAGE_ID } from "../cj4/CJ4_MessageDefinitions";
import { MESSAGE_LEVEL, MESSAGE_TARGET } from "./MessageDefinition";
export declare class Message {
    private _content;
    private _level;
    private _weight;
    private _target;
    private _timestamp;
    private _id;
    /** Gets the unix timestamp for when the message was created */
    get timestamp(): number;
    /** Gets the ID of the message definition */
    get Id(): FMS_MESSAGE_ID;
    /** Gets the {@link MessageLevel} of severity of the message */
    get level(): MESSAGE_LEVEL;
    /** Gets the message weight (priority) */
    get weight(): number;
    /** Gets the message target display */
    get target(): MESSAGE_TARGET;
    /** Gets the text content of this message */
    get content(): string;
    /**
     * Constructs a new instance of Message
     * @param _content The message text
     * @param _level The {@link MessageLevel} of this message
     * @param _weight The message weight (priority)
     * @param _target The message target display
     */
    constructor(_content: string, _level: MESSAGE_LEVEL, _weight: number, _target: MESSAGE_TARGET);
}
