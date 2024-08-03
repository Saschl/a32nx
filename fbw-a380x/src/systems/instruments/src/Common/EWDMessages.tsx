const EWDMessages = {
  '000000001': '              \x1b<3mNORMAL',
  '000001001': ' \x1b<7m\x1b4mT.O\x1bm',
  '000001002': '   \x1b<5m-SIGNS .........ON',
  '000001003': '   \x1b<3m-SIGNS ON',
  '000001004': '   \x1b<5m-CABIN ......CHECK',
  '000001005': '   \x1b<3m-CABIN READY',
  '000001006': '   \x1b<5m-SPLRs ........ARM',
  '000001007': '   \x1b<3m-SPLRs ARM',
  '000001008': '   \x1b<5m-FLAPS ........T.O',
  '000001009': '   \x1b<3m-FLAPS : T.O',
  '000001010': '   \x1b<5m-AUTO BRAKE ...RTO',
  '000001011': '   \x1b<3m-AUTO BRAKE RTO',
  '000001012': '   \x1b<5m-T.O CONFIG ..TEST',
  '000001013': '   \x1b<3m-T.O CONFIG NORMAL',
  '000002001': ' \x1b<7m\x1b4mLDG\x1bm',
  '000002002': '   \x1b<5m-SIGNS .........ON',
  '000002003': '   \x1b<3m-SIGNS ON',
  '000002004': '   \x1b<5m-CABIN ......CHECK',
  '000002005': '   \x1b<3m-CABIN READY',
  '000002006': '   \x1b<5m-LDG GEAR ....DOWN',
  '000002007': '   \x1b<3m-LDG GEAR DOWN',
  '000002008': '   \x1b<5m-FLAPS ........LDG',
  '000002009': '   \x1b<3m-FLAPS : LDG',
  '000002010': '   \x1b<5m-SPLRs ........ARM',
  '000002011': '   \x1b<3m-SPLRs ARM',
  '320000001': '\x1b<4mAUTO BRK OFF',
  '320000002': '\x1b<3mPARK BRK ON',
  '321000001': '\x1b<3mFLT L/G DOWN',
  '321000002': '\x1b<3mL/G GRVTY EXTN',
  '322000001': '\x1b<4mN/W STEER DISC',
  '322000002': '\x1b<3mN/W STEER DISC',
  '000005001': '\x1b<3mREFUELG',
  '000005501': '\x1b<3mGND SPLRs ARMED',
  '000056101': '\x1b<3mCOMPANY ALERT',
  '000056102': '\x1b<3m\x1b)mCOMPANY ALERT',
  '000006001': '\x1b<3mSPEED BRK',
  '000006002': '\x1b<4mSPEED BRK',
  '000010501': '\x1b<3mOUTR TK FUEL XFRD',
  '000011001': '\x1b<3mFOB BELOW 3 T',
  '000011002': '\x1b<3mFOB BELOW 6600 LBS',
  '000013501': '\x1b<3mACARS STBY',
  '000030501': '\x1b<3mGPWS FLAP MODE OFF',
  '000066001': '\x1b<3mGSM DISC < 4MN',
  '290000001': '\x1b<3mG ELEC PMP A CTL',
  '290000002': '\x1b<3mG ELEC PMP B CTL',
  '290000003': '\x1b<3mY ELEC PMP A CTL',
  '290000004': '\x1b<3mY ELEC PMP B CTL',
  '000017001': '\x1b<3mAPU AVAIL',
  '000018001': '\x1b<3mAPU BLEED',
  '000019001': '\x1b<3mLDG LT',
  '240000001': '\x1b<3mCOMMERCIAL PART SHED',
  '241000001': '\x1b<4mELEC EXT PWR',
  '241000002': '\x1b<3mELEC EXT PWR',
  '242000001': '\x1b<4mRAT OUT',
  '242000002': '\x1b<3mRAT OUT',
  '243000001': '\x1b<3mREMOTE C/B CTL ON',
  '000023001': '\x1b<3mMAN LDG ELEV',
  '000025001': '\x1b<3mFUEL X FEED',
  '000025002': '\x1b<4mFUEL X FEED',
  '000026001': '\x1b<3mENG A. ICE',
  '000027001': '\x1b<3mWING A. ICE',
  '000027501': '\x1b<3mICE NOT DET',
  '000029001': '\x1b<3mSWITCHG PNL',
  '000030001': '\x1b<3mGPWS FLAP 3',
  '000032001': '\x1b<3mTCAS STBY',
  '000032501': '\x1b<4mTCAS STBY',
  '000035001': '\x1b<2mLAND ASAP',
  '000036001': '\x1b<4mLAND ASAP',
  '000054001': '\x1b<3mPRED W/S OFF',
  '000054002': '\x1b<4mPRED W/S OFF',
  '000054501': '\x1b<3mTERR OFF',
  '000054502': '\x1b<4mTERR OFF',
  '000055201': '\x1b<3mCOMPANY MSG',
  '000056001': '\x1b<3mHI ALT SET',
  '220000001': '\x1b<2mAP OFF',
  '220000002': '\x1b<4mA/THR OFF',
  '221000001': '\x1b<3mFMS SWTG',
  '230000001': '\x1b<3mCAPT ON RMP 3',
  '230000002': '\x1b<3mF/O ON RMP 3',
  '230000003': '\x1b<3mCAPT+F/O ON RMP 3',
  '230000004': '\x1b<3mCABIN READY',
  '230000005': '\x1b<3mCPNY DTLNK NOT AVAIL',
  '230000006': '\x1b<3mGND HF DATALINK OVRD',
  '230000007': '\x1b<3mHF VOICE',
  '230000008': '\x1b<3mPA IN USE',
  '230000009': '\x1b<3mRMP 1+2+3 OFF',
  '230000010': '\x1b<3mRMP 1+3 OFF',
  '230000011': '\x1b<3mRMP 2+3 OFF',
  '230000012': '\x1b<3mRMP 3 OFF',
  '230000013': '\x1b<3mSATCOM ALERT',
  '230000014': '\x1b<3mVHF DTLNK MAN SCAN',
  '230000015': '\x1b<3mVHF VOICE',
  '271000001': '\x1b<3mGND SPLRs ARMED',
  '280000001': '\x1b<3mCROSSFEED OPEN',
  '280000002': '\x1b<3mCOLDFUEL OUTR TK XFR',
  '280000003': '\x1b<3mDEFUEL IN PROGRESS',
  '280000004': '\x1b<3mFWD XFR IN PROGRESS',
  '280000005': '\x1b<3mGND XFR IN PROGRESS',
  '280000006': '\x1b<3mJETTISON IN PROGRESS',
  '280000007': '\x1b<3mOUTR TK XFR IN PROG',
  '280000008': '\x1b<3mOUTR TKS XFRD',
  '280000009': '\x1b<3mREFUEL IN PROGRESS',
  '280000010': '\x1b<3mREFUEL PNL DOOR OPEN',
  '280000011': '\x1b<3mREFUEL PNL DOOR OPEN',
  '280000012': '\x1b<3mTRIM TK XFRD',
  '308118601': '\x1b<4m\x1b4mSEVERE ICE\x1bm DETECTED',
  '310000001': '\x1b<4mMEMO NOT AVAIL',
  '314000001': '\x1b<6mT.O INHIBIT',
  '314000002': '\x1b<6mLDG INHIBIT',
  '317000001': '\x1b<3mCLOCK INT',
  '340000001': '\x1b<3mTRUE NORTH REF',
  '340002701': '\x1b<3mIR 1 IN ATT ALIGN',
  '340002702': '\x1b<3mIR 2 IN ATT ALIGN',
  '340002703': '\x1b<3mIR 3 IN ATT ALIGN',
  '340002704': '\x1b<3mIR 1+2 IN ATT ALIGN',
  '340002705': '\x1b<3mIR 1+3 IN ATT ALIGN',
  '340002706': '\x1b<3mIR 2+3 IN ATT ALIGN',
  '340002707': '\x1b<3mIR 1+2+3 IN ATT ALIGN',
  '340003001': '\x1b<3mIR IN ALIGN > 7 MN',
  '340003002': '\x1b<4mIR IN ALIGN > 7 MN',
  '340003003': '\x1b<3mIR IN ALIGN 6 MN',
  '340003004': '\x1b<4mIR IN ALIGN 6 MN',
  '340003005': '\x1b<3mIR IN ALIGN 5 MN',
  '340003006': '\x1b<4mIR IN ALIGN 5 MN',
  '333000001': '\x1b<3mSTROBE LT OFF',
  '335000001': '\x1b<3mSEAT BELTS',
  '335000002': '\x1b<3mNO SMOKING',
  '335000003': '\x1b<3mNO MOBILE',
  '340003007': '\x1b<3mIR IN ALIGN 4 MN',
  '340003008': '\x1b<4mIR IN ALIGN 4 MN',
  '340003101': '\x1b<3mIR IN ALIGN 3 MN',
  '340003102': '\x1b<4mIR IN ALIGN 3 MN',
  '340003103': '\x1b<3mIR IN ALIGN 2 MN',
  '340003104': '\x1b<4mIR IN ALIGN 2 MN',
  '340003105': '\x1b<3mIR IN ALIGN 1 MN',
  '340003106': '\x1b<4mIR IN ALIGN 1 MN',
  '340003107': '\x1b<3mIR IN ALIGN',
  '340003108': '\x1b<4mIR IN ALIGN',
  '340003109': '\x1b<3mIR ALIGNED',
  '340068001': '\x1b<3mADIRS SWTG',
  '709000001': '\x1b<3mIGNITION',
    220200001: '\x1b<3mFMS 1 ON FMC-C',
  220200002: '\x1b<3mFMS 2 ON FMC-C',
  220200003: '\x1b<3mSTBY INSTRUMENTS NAV AVAIL',
  220200004: '\x1b<3mCAT 2 ONLY',
  220200005: '\x1b<3mCAT 3 SINGLE ONLY',
  220200006: '\x1b<3mFOR AUTOLAND: MAN ROLL OUT ONLY',
  220200007: '\x1b<3mAPPR MODE NOT AVAIL',
  220200008: '\x1b<3mLOC MODE AVAIL ONLY',
  220200009: '\x1b<3mWHEN L/G DOWN AND AP OFF: USE MAN PITCH TRIM',
  230200001: '\x1b<3mSATCOM DATALINK AVAIL',
  340200002: '\x1b<3mALTN LAW : PROT LOST',
  340200003: '\x1b<3mFLS LIMITED TO F-APP + RAW',
  340200004: '\x1b<3mDIRECT LAW : PROT LOST',
  340200005: '\x1b<3mPFD BKUP SPEED & ALT AVAIL',
  340200006: '\x1b<3mFPV / VV AVAIL',
  340200007: '\x1b<3mCABIN ALT TRGT: SEE FCOM', // TODO add table
    230400001: '\x1b<5mNO COM AVAIL',
  240400001: '\x1b<5mGA THR : TOGA ONLY',
  240400002: '\x1b<5mMAX SPEED: 310/.86',
  240400003: '\x1b<5mSPD BRK: DO NOT USE',
  240400004: '\x1b<5mMANEUVER WITH CARE',
  300400001: '\x1b<5mAVOID ICING CONDs',
};

export default EWDMessages;
