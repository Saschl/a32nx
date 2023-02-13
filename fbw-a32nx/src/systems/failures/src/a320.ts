// One can rightfully argue that this constant shouldn't be located in @flybywiresim/failures.
// Once we create an A320 specific package, such as @flybywiresim/a320, we can move it there.
export const A320Failure = Object.freeze({
    Fac1Failure: 22000,
    Fac2Failure: 22001,
    TransformerRectifier1: 24000,
    TransformerRectifier2: 24001,
    TransformerRectifierEssential: 24002,
    Elac1Failure: 27000,
    Elac2Failure: 27001,
    Sec1Failure: 27002,
    Sec2Failure: 27003,
    Sec3Failure: 27004,
    Fcdc1Failure: 27005,
    Fcdc2Failure: 27006,

    GreenReservoirLeak: 29000,
    BlueReservoirLeak: 29001,
    YellowReservoirLeak: 29002,
    GreenReservoirAirLeak: 29003,
    BlueReservoirAirLeak: 29004,
    YellowReservoirAirLeak: 29005,
    GreenReservoirReturnLeak: 29006,
    BlueReservoirReturnLeak: 29007,
    YellowReservoirReturnLeak: 29008,
    GreenEdpOverheat: 29009,
    BlueEpumpOverheat: 29010,
    YellowEdpOverheat: 29011,
    YellowEpumpOverheat: 29012,

    LeftPfdDisplay: 31000,
    RightPfdDisplay: 31001,

    FlightWarningComputer1: 31500,
    FlightWarningComputer2: 31501,

    LgciuPowerSupply1: 32000,
    LgciuPowerSupply2: 32001,
    LgciuInternalError1: 32002,
    LgciuInternalError2: 32003,

    GearProxSensorDamageGearUplockNose1: 32004,
    GearProxSensorDamageGearDownlockNose2: 32005,
    GearProxSensorDamageGearUplockRight1: 32006,
    GearProxSensorDamageGearDownlockRight2: 32007,
    GearProxSensorDamageGearUplockLeft2: 32008,
    GearProxSensorDamageGearDownlockLeft1: 32009,

    GearProxSensorDamageGearDoorClosedNose1: 32010,
    GearProxSensorDamageGearDoorOpenedNose2: 32011,
    GearProxSensorDamageGearDoorClosedRight2: 32012,
    GearProxSensorDamageGearDoorOpenedRight1: 32013,
    GearProxSensorDamageGearDoorClosedLeft2: 32014,
    GearProxSensorDamageGearDoorOpenedLeft1: 32015,

    GearActuatorJammedGearNose: 32020,
    GearActuatorJammedGearLeft: 32021,
    GearActuatorJammedGearRight: 32022,
    GearActuatorJammedGearDoorNose: 32023,
    GearActuatorJammedGearDoorLeft: 32024,
    GearActuatorJammedGearDoorRight: 32025,

    GreenBrakeHydraulicLeak: 32100,
    YellowBrakeHydraulicLeak: 32101,
    YellowBrakeAccumulatorGasLeak: 32150,

    RadioAltimeter1: 34000,
    RadioAltimeter2: 34001,
});
