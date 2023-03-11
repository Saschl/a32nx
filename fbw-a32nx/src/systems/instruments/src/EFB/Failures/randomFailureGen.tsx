import { useEffect, useMemo } from 'react';
import { Failure } from '@failures';
import { usePersistentNumberProperty, usePersistentProperty } from '@instruments/common/persistence';
import { failureGenConfigAltClimb, failureGeneratorAltClimb }
    from 'instruments/src/EFB/Failures/FailureGenerators/AltitudeClimbFailureGenerator';
import { failureGenConfigAltDesc, failureGeneratorAltDesc }
    from 'instruments/src/EFB/Failures/FailureGenerators/AltitudeDescentFailureGenerator';
import { failureGenConfigPerHour, failureGeneratorPerHour }
    from 'instruments/src/EFB/Failures/FailureGenerators/PerHourFailureGenerator';
import { failureGenConfigSpeedAccel, failureGeneratorSpeedAccel }
    from 'instruments/src/EFB/Failures/FailureGenerators/SpeedAccelFailureGenerator';
import { failureGenConfigSpeedDecel, failureGeneratorSpeedDecel }
    from 'instruments/src/EFB/Failures/FailureGenerators/SpeedDecelFailureGenerator';
import { failureGenConfigTakeOff, failureGeneratorTakeOff }
    from 'instruments/src/EFB/Failures/FailureGenerators/TakeOffFailureGenerator';
import { failureGenConfigTimer, failureGeneratorTimer } from 'instruments/src/EFB/Failures/FailureGenerators/TimerFailureGenerator';
import { useFailuresOrchestrator } from '../failures-orchestrator-provider';

export const failureGeneratorCommonFunction = () => {
    const [maxFailuresAtOnce, setMaxFailuresAtOnce] = usePersistentNumberProperty('EFB_MAX_FAILURES_AT_ONCE', 2);
    const { changingFailures, activeFailures, allFailures, activate } = useFailuresOrchestrator();
    const totalActiveFailures = useMemo(() => changingFailures.size + activeFailures.size, [changingFailures, activeFailures]);
    return { maxFailuresAtOnce, setMaxFailuresAtOnce, changingFailures, activeFailures, totalActiveFailures, allFailures, activate };
};

export type FailureGenData = {setting: string, setSetting : (value: string) => void, settings : number[],
    numberOfSettingsPerGenerator : number, uniqueGenPrefix : string, additionalSetting : number[], onErase : (genID : number) => void,
    failureGeneratorArmed:boolean[], genName : string, FailureGeneratorCard : (genID: number, generatorSettings: FailureGenData) => JSX.Element}

export const flatten = (settings : number[]) => {
    let settingString = '';
    for (let i = 0; i < settings.length; i++) {
        settingString += settings[i].toString();
        if (i < settings.length - 1) settingString += ',';
    }
    return settingString;
};

export enum FailurePhases {
    DORMANT= 0,
    TAKEOFF= 1,
    INITIALCLIMB= 2,
    FLIGHT= 3,
}

export const allGeneratorFailures = (allFailures : readonly Readonly<Failure>[]) => {
    const generatorFailuresGetters : Map<number, string> = new Map();
    const generatorFailuresSetters : Map<number, (value: string) => void> = new Map();
    if (allFailures.length > 0) {
        allFailures.forEach((failure) => {
            const [generatorSetting, setGeneratorSetting] = usePersistentProperty(`EFB_FAILURE_${failure.identifier.toString()}_GENERATORS`, '');
            generatorFailuresGetters.set(failure.identifier, generatorSetting);
            generatorFailuresSetters.set(failure.identifier, setGeneratorSetting);
        });
    }
    return { generatorFailuresGetters, generatorFailuresSetters };
};

export const deleteGeneratorFailures = (allFailures : readonly Readonly<Failure>[], generatorFailuresGetters : Map<number, string>,
    generatorFailuresSetters : Map<number, (value: string) => void>, generatorUniqueIDRemoved: string) => {
    // console.info('Looking for failures on generator %s', generatorUniqueID);
    const removedLetter = generatorUniqueIDRemoved.match(/\D{1-2}/)[0];
    const removedNumber = parseInt(generatorUniqueIDRemoved.match(/\D{1-2}/)[0]);
    if (allFailures.length > 0) {
        allFailures.forEach((failure) => {
            let first = true;
            const generatorSetting = generatorFailuresGetters.get(failure.identifier);
            console.info(generatorSetting);
            let newString = '';
            if (generatorSetting) {
                const failureGeneratorsTable = generatorSetting.split(',');
                if (failureGeneratorsTable.length > 0) {
                    failureGeneratorsTable.forEach((generator) => {
                        const generatorNumber = parseInt(generator.match(/\d{1-2}/)[0]);
                        const generatorLetter = generator.match(/\D{1-2}/)[0];
                        if (generatorLetter !== removedLetter || generatorNumber < removedNumber) {
                            newString = newString.concat(first ? `${generator}` : generator);
                            first = false;
                        } else if (generatorNumber > removedNumber) {
                            const offset = `${generatorLetter}${(generatorNumber - 1).toString()}`;
                            newString = newString.concat(first ? `${offset}` : offset);
                            first = false;
                        }
                    });
                    console.info(newString);
                    generatorFailuresSetters.get(failure.identifier)(newString);
                }
            }
        });
    }
};

export const findGeneratorFailures = (allFailures : readonly Readonly<Failure>[], generatorFailuresGetters : Map<number, string>, generatorUniqueID: string) => {
    // console.info('Looking for failures on generator %s', generatorUniqueID);
    const failureIDs : Failure[] = [];
    if (allFailures.length > 0) {
        allFailures.forEach((failure) => {
            const generatorSetting = generatorFailuresGetters.get(failure.identifier);
            if (generatorSetting) {
                const failureGeneratorsTable = generatorSetting.split(',');
                if (failureGeneratorsTable.length > 0) {
                    failureGeneratorsTable.forEach((generator) => {
                        if (generator === generatorUniqueID) failureIDs.push(failure);
                    });
                }
            }
        });
    }
    return failureIDs;
};

export const activateRandomFailure = (failureList : readonly Readonly<Failure>[], activate : ((identifier: number) => Promise<void>), activeFailures : Set<number>, _generatorID : string) => {
    const failuresOffMap = failureList.filter((failure) => !activeFailures.has(failure.identifier)).map((failure) => failure.identifier);
    console.info('list of #%d failures, only %d active', failureList.length, failuresOffMap.length);
    if (failuresOffMap.length > 0) {
        const pick = Math.floor(Math.random() * failuresOffMap.length);
        const pickedFailure = failureList.find((failure) => failure.identifier === failuresOffMap[pick]);
        if (pickedFailure) {
            console.info('Failure #%d triggered: %s', pickedFailure.identifier, pickedFailure.name);
            activate(failuresOffMap[pick]);
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

export const failureGeneratorsSettings = () => {
    const { maxFailuresAtOnce, setMaxFailuresAtOnce } = failureGeneratorCommonFunction();
    const allGenSettings : Map<string, FailureGenData> = new Map();
    allGenSettings.set(failureGenConfigTakeOff().genName, failureGenConfigTakeOff());
    allGenSettings.set(failureGenConfigPerHour().genName, failureGenConfigPerHour());
    allGenSettings.set(failureGenConfigTimer().genName, failureGenConfigTimer());
    allGenSettings.set(failureGenConfigSpeedAccel().genName, failureGenConfigSpeedAccel());
    allGenSettings.set(failureGenConfigSpeedDecel().genName, failureGenConfigSpeedDecel());
    allGenSettings.set(failureGenConfigAltClimb().genName, failureGenConfigAltClimb());
    allGenSettings.set(failureGenConfigAltDesc().genName, failureGenConfigAltDesc());
    return {
        maxFailuresAtOnce,
        setMaxFailuresAtOnce,
        allGenSettings,
    };
};

const failureGenerators : ((generatorFailuresGetters : Map<number, string>) => void)[] = [
    failureGeneratorAltClimb,
    failureGeneratorAltDesc,
    failureGeneratorSpeedAccel,
    failureGeneratorSpeedDecel,
    failureGeneratorPerHour,
    failureGeneratorTimer,
    failureGeneratorTakeOff,
];

export const randomFailureGenerator = () => {
    const { failureFlightPhase } = basicData();
    const { allFailures } = failureGeneratorCommonFunction();
    const { generatorFailuresGetters, generatorFailuresSetters } = allGeneratorFailures(allFailures);

    // TODO: to be improved, changing doesn't mean active but this is not critical

    for (let i = 0; i < failureGenerators.length; i++) {
        failureGenerators[i](generatorFailuresGetters);
    }

    useEffect(() => {
        console.info('Failure phase: %d', failureFlightPhase);
    }, [failureFlightPhase]);

    useEffect(() => {
        generatorFailuresSetters.get(22000)('');
        generatorFailuresSetters.get(22001)('');
        generatorFailuresSetters.get(24000)('');
        generatorFailuresSetters.get(24001)('');
        generatorFailuresSetters.get(24002)('');
        generatorFailuresSetters.get(27000)('');
        generatorFailuresSetters.get(27001)('');
        generatorFailuresSetters.get(27002)('G0');
        generatorFailuresSetters.get(27003)('G1');
        generatorFailuresSetters.get(27004)('');
        generatorFailuresSetters.get(27005)('');
        generatorFailuresSetters.get(27006)('');
        generatorFailuresSetters.get(29000)('');
        generatorFailuresSetters.get(29001)('');
        generatorFailuresSetters.get(29002)('');
        generatorFailuresSetters.get(29003)('');
        generatorFailuresSetters.get(29004)('');
        generatorFailuresSetters.get(29005)('');
        generatorFailuresSetters.get(29006)('');
        generatorFailuresSetters.get(29007)('');
        generatorFailuresSetters.get(29008)('');
        generatorFailuresSetters.get(29009)('');
        generatorFailuresSetters.get(29010)('');
        generatorFailuresSetters.get(29011)('');
        generatorFailuresSetters.get(29012)('');
        generatorFailuresSetters.get(31000)('');
        generatorFailuresSetters.get(31001)('');
        generatorFailuresSetters.get(32000)('');
        generatorFailuresSetters.get(32001)('');
        generatorFailuresSetters.get(32002)('');
        generatorFailuresSetters.get(32003)('');
        generatorFailuresSetters.get(32004)('');
        generatorFailuresSetters.get(32005)('');
        generatorFailuresSetters.get(32006)('');
        generatorFailuresSetters.get(32007)('');
        generatorFailuresSetters.get(32008)('');
        generatorFailuresSetters.get(32009)('');
        generatorFailuresSetters.get(32010)('');
        generatorFailuresSetters.get(32011)('');
        generatorFailuresSetters.get(32012)('');
        generatorFailuresSetters.get(32013)('');
        generatorFailuresSetters.get(32014)('');
        generatorFailuresSetters.get(32015)('');
        generatorFailuresSetters.get(32020)('');
        generatorFailuresSetters.get(32021)('');
        generatorFailuresSetters.get(32022)('');
        generatorFailuresSetters.get(32023)('');
        generatorFailuresSetters.get(32024)('');
        generatorFailuresSetters.get(32025)('');
        generatorFailuresSetters.get(32100)('');
        generatorFailuresSetters.get(32101)('');
        generatorFailuresSetters.get(32150)('');
        generatorFailuresSetters.get(34000)('');
        generatorFailuresSetters.get(34001)('');
    }, []);
};

export const failureGeneratorAdd = (generatorsSettings : FailureGenData) => {
    if (generatorsSettings.settings === undefined || generatorsSettings.settings.length % generatorsSettings.numberOfSettingsPerGenerator !== 0 || generatorsSettings.settings.length === 0) {
        // console.warn('Undefined generator setting, resetting');
        generatorsSettings.setSetting(flatten(generatorsSettings.additionalSetting));
    } else generatorsSettings.setSetting(flatten(generatorsSettings.settings.concat(generatorsSettings.additionalSetting)));
};

export function setNewSetting(newSetting: number, generatorSettings : FailureGenData, genID : number, settingIndex : number) {
    const settings = generatorSettings.settings;
    settings[genID * generatorSettings.numberOfSettingsPerGenerator + settingIndex] = newSetting;
    generatorSettings.setSetting(flatten(settings));
}

export const eraseGenerator :(genID : number, generatorSettings : FailureGenData) => void = (genID : number, generatorSettings : FailureGenData) => {
    generatorSettings.settings.splice(genID * generatorSettings.numberOfSettingsPerGenerator, generatorSettings.numberOfSettingsPerGenerator);
    generatorSettings.setSetting(flatten(generatorSettings.settings));
    // arming
    generatorSettings.failureGeneratorArmed.splice(genID * generatorSettings.numberOfSettingsPerGenerator, generatorSettings.numberOfSettingsPerGenerator);
    generatorSettings.onErase(genID);
};
