import { Message } from "../../messages/Message";
export declare class CJ4_PFD_Message extends Message {
    private _blinkCheckHandler;
    get blinkCheckHandler(): () => boolean;
    set blinkCheckHandler(v: () => boolean);
    /** Returns a boolean indicating if the message should blink */
    shouldBlink(): boolean;
    private _isBlinking;
    get isBlinking(): boolean;
    set isBlinking(v: boolean);
}
