import { useState, useEffect, useMemo } from 'react';
import { useSimVar } from '@instruments/common/simVars';
import { Failure } from '@failures';
import { usePersistentNumberProperty, usePersistentProperty } from '@instruments/common/persistence';
import { failureGeneratorAltClimb } from 'instruments/src/EFB/Failures/FailureGenerators/AltitudeFailureGenerators';
import { failureGeneratorTimeBased } from 'instruments/src/EFB/Failures/FailureGenerators/TimeBasedFailureGenerators';
import { useFailuresOrchestrator } from '../failures-orchestrator-provider';

export const failureGeneratorCommonFunction = () => {
    const [maxFailuresAtOnce] = usePersistentNumberProperty('EFB_MAX_FAILURES_AT_ONCE', 2);
    const { changingFailures, activeFailures, allFailures, activate } = useFailuresOrchestrator();
    const totalActiveFailures = useMemo(() => changingFailures.size + activeFailures.size, [changingFailures, activeFailures]);
    return { maxFailuresAtOnce, changingFailures, activeFailures, totalActiveFailures, allFailures, activate };
};

// keep this template for new failureGenerators
export const failureGeneratorTEMPLATE = () => {
    // FAILURE GENERATOR DESCRIPTION
    const [absoluteTime5s] = useSimVar('E:ABSOLUTE TIME', 'seconds', 5000);
    const { maxFailuresAtOnce, totalActiveFailures, allFailures, activate } = failureGeneratorCommonFunction();
    const [failureGeneratorSettingTEMPLATE] = usePersistentProperty('EFB_FAILURE_GENERATOR_SETTING_TEMPLATE', '0,1');
    const [failureGeneratorArmedTEMPLATE, setFailureGeneratorArmedTEMPLATE] = useState<boolean[]>();
    const settingsTEMPLATE : number[] = useMemo<number[]>(() => failureGeneratorSettingTEMPLATE.split(',').map(((it) => parseFloat(it))), [failureGeneratorSettingTEMPLATE]);
    const numberOfSettingsPerGenerator = 1;
    const nbGeneratorTEMPLATE = useMemo(() => Math.floor(settingsTEMPLATE.length / numberOfSettingsPerGenerator), [settingsTEMPLATE]);

    useEffect(() => {
        // FAILURETYPE failures
        const tempFailureGeneratorArmedTEMPLATE : boolean[] = Array.from(failureGeneratorArmedTEMPLATE);
        for (let i = 0; i < nbGeneratorTEMPLATE; i++) {
            const failureConditionPLACEHOLDER = settingsTEMPLATE[i * numberOfSettingsPerGenerator + 0] >= 1; // CONDITIONS HERE
            if (tempFailureGeneratorArmedTEMPLATE[i] && failureConditionPLACEHOLDER && totalActiveFailures < maxFailuresAtOnce) {
                activateRandomFailure(allFailures, activate);
                console.info('TEMPLATE failure triggered');
                tempFailureGeneratorArmedTEMPLATE[i] = false;
            }
        }
        setFailureGeneratorArmedTEMPLATE(tempFailureGeneratorArmedTEMPLATE);
    }, [absoluteTime5s]);

    useEffect(() => {
        // failureSettings once per start of takeoff
        const tempFailureGeneratorArmedTEMPLATE : boolean[] = Array.from(failureGeneratorArmedTEMPLATE);
        for (let i = 0; i < nbGeneratorTEMPLATE; i++) {
            // SPECIFIC INIT HERE PER GENERATOR
            tempFailureGeneratorArmedTEMPLATE[i] = true;
        }
        setFailureGeneratorArmedTEMPLATE(tempFailureGeneratorArmedTEMPLATE);
    }, []); // specific update conditions
};
/*
enum FailureGeneratorType {
    TAKE_OFF= 0,
    TIMEBASED= 1,
    MTTF= 2,
    ALT_CLIMB= 3,
    ALT_DESC= 4,
    SPEED_ACCEL= 5,
    SPEED_DECEL= 6,
}
*/

export enum FailurePhases {
    DORMANT= 0,
    TAKEOFF= 1,
    INITIALCLIMB= 2,
    FLIGHT= 3,
}

export const activateRandomFailure = (allFailures : readonly Readonly<Failure>[], activate : ((identifier: number) => Promise<void>)) => {
    const failureArray = allFailures.map((it) => it.identifier);
    // Object.values(allFailures)
    if (failureArray.length > 0) {
        const pick = Math.floor(Math.random() * failureArray.length);
        const pickedFailure = allFailures.find((failure) => failure.identifier === failureArray[pick]);
        if (pickedFailure) {
            console.info('Failure #%d triggered: %s', pickedFailure.identifier, pickedFailure.name);
            activate(pickedFailure.identifier);
        }
    }
};

export const basicData = () => {
    const isOnGround = SimVar.GetSimVarValue('SIM ON GROUND', 'Bool');
    const maxThrottleMode = Math.max(Simplane.getEngineThrottleMode(0), Simplane.getEngineThrottleMode(1));
    const throttleTakeOff = useMemo(() => (maxThrottleMode === ThrottleMode.FLEX_MCT || maxThrottleMode === ThrottleMode.TOGA), [maxThrottleMode]);
    const failureFlightPhase = useMemo(() => {
        if (isOnGround) {
            if (throttleTakeOff) return FailurePhases.TAKEOFF;
            return FailurePhases.DORMANT;
        }
        if (throttleTakeOff) return FailurePhases.INITIALCLIMB;
        return FailurePhases.FLIGHT;
    }, [throttleTakeOff, isOnGround]);
    return { isOnGround, maxThrottleMode, throttleTakeOff, failureFlightPhase };
};

export const randomFailureGenerator = () => {
    const failureGenerators : (() => void)[] = [];
    const { failureFlightPhase } = basicData();

    failureGenerators.push(failureGeneratorTimeBased);
    // failureGenerators.push(failureGeneratorTakeOff);
    failureGenerators.push(failureGeneratorAltClimb);
    // failureGenerators.push(failureGeneratorAltDesc);
    // failureGenerators.push(failureGeneratorMTTF);
    // failureGenerators.push(failureGeneratorSpeedAccel);
    // failureGenerators.push(failureGeneratorSpeedDecel);

    // TODO: to be improved, changing doesn't mean active but this is not critical

    for (let i = 0; i < failureGenerators.length; i++) {
        failureGenerators[i]();
    }

    useEffect(() => {
        console.info('Failure phase: %d', failureFlightPhase);
    }, [failureFlightPhase]);
};
