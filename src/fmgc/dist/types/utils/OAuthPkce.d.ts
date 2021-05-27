export interface PkceChallenge {
    code_verifier: string;
    code_challenge: string;
}
export declare class OAuthPkce {
    static sha256(r: string): any;
    private static getRandomBytes;
    private static arrayBufferToBase64;
    private static base64URLEncode;
    private static hexStringToBytes;
    static getChallenge(len: number): PkceChallenge;
}
