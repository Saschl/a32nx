// Copyright (c) 2021-2023 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { useMemo, useState } from 'react';
import { Failure } from '@failures';
import { usePersistentProperty, useSimVar } from '@flybywiresim/fbw-sdk';
import { failureGenConfigAltitude } from 'instruments/src/EFB/Failures/FailureGenerators/AltitudeFailureGeneratorUI';
import { failureGenConfigPerHour } from 'instruments/src/EFB/Failures/FailureGenerators/PerHourFailureGeneratorUI';
import { failureGenConfigSpeed } from 'instruments/src/EFB/Failures/FailureGenerators/SpeedFailureGeneratorUI';
import { failureGenConfigTakeOff } from 'instruments/src/EFB/Failures/FailureGenerators/TakeOffFailureGeneratorUI';
import { failureGenConfigTimer } from 'instruments/src/EFB/Failures/FailureGenerators/TimerFailureGeneratorUI';
import { ArmingModeIndex, FailuresAtOnceIndex, MaxFailuresIndex } from 'instruments/src/EFB/Failures/FailureGenerators/FailureGeneratorsUI';
import { EventBus } from '@microsoft/msfs-sdk';
import { useFailuresOrchestrator } from '../../failures-orchestrator-provider';

export interface FailureGenFeedbackEvent {
    expectedMode: { generatorType: string, mode: number[] };
    armingDisplayStatus: { generatorType: string, status: boolean[] };
  }

export interface FailureGenEvent {
    refreshData: boolean;
    settings: {generatorType: string, settingsString: string}
}

/**
 * Data for a generator
 *
 * TODO confirm
 */
export type FailureGenData = {
    /**
     * TODO replace with redux action
     */
    setSetting: (value: string) => void,
    /**
     * TODO put in redux
     */
    settings: number[],
    /**
     * TODO confirm - does this vary per generator?
     */
    numberOfSettingsPerGenerator: number,
    /**
     * TODO put in redux
     */
    uniqueGenPrefix: string,
    /**
     * TODO put in redux, confirm - what even is this for?
     */
    additionalSetting: number[],
    /**
     * TODO put in redux
     */
    genName: string,
    /**
     * TODO move this to a react component
     */
    generatorSettingComponents: (genNumber: number, generatorSettings: FailureGenData, failureGenContext: FailureGenContext) => JSX.Element[],
    /**
     * TODO confirm - what is this for?
     */
    alias: () => string,
    /**
     * TODO put in redux
     */
    disableTakeOffRearm: boolean,
    /**
     * TODO put in redux
     */
    armedState: boolean[],
}

export type FailureGenContext = {
    allGenSettings: Map<string, FailureGenData>,
    generatorFailuresGetters: Map<number, string>,
    generatorFailuresSetters: Map<number, (value: string) => void>,
    modalContext: ModalContext,
    setModalContext: (modalContext: ModalContext) => void,
    failureGenModalType: ModalGenType
    setFailureGenModalType: (type: ModalGenType) => void,
}

export type ModalContext = {
    failureGenData: FailureGenData,
    genNumber: number,
    genUniqueID: string,
}

export enum ModalGenType {None, Settings, Failures}

export const flatten = (settings: number[]) => {
    let settingString = '';
    for (let i = 0; i < settings.length; i++) {
        settingString += settings[i].toString();
        if (i < settings.length - 1) settingString += ',';
    }
    return settingString;
};

export enum FailurePhases {
    Dormant,
    TakeOff,
    InitialClimb,
    Flight,
}

export const basicData = () => {
    const [isOnGround] = useSimVar('SIM ON GROUND', 'Bool');
    const maxThrottleMode = Math.max(Simplane.getEngineThrottleMode(0), Simplane.getEngineThrottleMode(1));
    const throttleTakeOff = useMemo(() => (maxThrottleMode === ThrottleMode.FLEX_MCT || maxThrottleMode === ThrottleMode.TOGA), [maxThrottleMode]);
    const failureFlightPhase = useMemo(() => {
        if (isOnGround) {
            if (throttleTakeOff) return FailurePhases.TakeOff;
            return FailurePhases.Dormant;
        }
        if (throttleTakeOff) return FailurePhases.InitialClimb;
        return FailurePhases.Flight;
    }, [throttleTakeOff, isOnGround]);
    return { isOnGround, maxThrottleMode, throttleTakeOff, failureFlightPhase };
};

export const updateSettings: (settings: number[], setSetting: (value: string) => void, bus: EventBus, uniqueGenPrefix: string)
=> void = (settings: number[], setSetting: (value: string) => void, bus: EventBus, uniqueGenPrefix: string) => {
    const flattenedData = flatten(settings);
    sendSettings(uniqueGenPrefix, flattenedData, bus);
    setSetting(flattenedData);
};

export const useFailureGeneratorsSettings: () => FailureGenContext = () => {
    const { allFailures } = useFailuresOrchestrator();
    const { generatorFailuresGetters, generatorFailuresSetters } = allGeneratorFailures(allFailures);
    const allGenSettings: Map<string, FailureGenData> = new Map();
    const [failureGenModalType, setFailureGenModalType] = useState<ModalGenType>(ModalGenType.None);
    const [modalContext, setModalContext] = useState<ModalContext | undefined >(undefined);

    allGenSettings.set(failureGenConfigAltitude().genName, failureGenConfigAltitude());
    allGenSettings.set(failureGenConfigSpeed().genName, failureGenConfigSpeed());
    allGenSettings.set(failureGenConfigPerHour().genName, failureGenConfigPerHour());
    allGenSettings.set(failureGenConfigTimer().genName, failureGenConfigTimer());
    allGenSettings.set(failureGenConfigTakeOff().genName, failureGenConfigTakeOff());

    return {
        allGenSettings,
        generatorFailuresGetters,
        generatorFailuresSetters,
        failureGenModalType,
        setFailureGenModalType,
        modalContext,
        setModalContext,
    };
};

export function setNewSetting(bus: EventBus, newSetting: number, generatorSettings: FailureGenData, genID: number, settingIndex: number) {
    const settings = generatorSettings.settings;
    settings[genID * generatorSettings.numberOfSettingsPerGenerator + settingIndex] = newSetting;
    updateSettings(generatorSettings.settings, generatorSettings.setSetting, bus, generatorSettings.uniqueGenPrefix);
}

export function sendRefresh(bus: EventBus) {
    bus.getPublisher<FailureGenEvent>().pub('refreshData', true, true);
    console.info('requesting refresh');
}

export function sendSettings(uniqueGenPrefix: string, stringTosend: string, bus: EventBus) {
    let settingsString: string;
    if (stringTosend === undefined) settingsString = '';
    else settingsString = stringTosend;
    const generatorType = uniqueGenPrefix;
    console.info(`settings sent: ${generatorType} - ${settingsString}`);
    bus.getPublisher<FailureGenEvent>().pub('settings', { generatorType, settingsString }, true);
}

export const allGeneratorFailures = (allFailures: readonly Readonly<Failure>[]) => {
    const generatorFailuresGetters: Map<number, string> = new Map();
    const generatorFailuresSetters: Map<number, (value: string) => void> = new Map();
    if (allFailures.length > 0) {
        for (const failure of allFailures) {
            const [generatorSetting, setGeneratorSetting] = usePersistentProperty(`EFB_FAILURE_${failure.identifier.toString()}_GENERATORS`, '');
            generatorFailuresGetters.set(failure.identifier, generatorSetting);
            generatorFailuresSetters.set(failure.identifier, setGeneratorSetting);
        }
    }
    return { generatorFailuresGetters, generatorFailuresSetters };
};

export const findGeneratorFailures = (allFailures: readonly Readonly<Failure>[], generatorFailuresGetters: Map<number, string>, generatorUniqueID: string) => {
    const failureIDs: Failure[] = [];

    if (allFailures.length > 0) {
        for (const failure of allFailures) {
            const generatorSetting = generatorFailuresGetters.get(failure.identifier);
            if (generatorSetting) {
                const failureGeneratorsTable = generatorSetting.split(',');
                if (failureGeneratorsTable.length > 0) {
                    for (const generator of failureGeneratorsTable) {
                        if (generator === generatorUniqueID) failureIDs.push(failure);
                    }
                }
            }
        }
    }

    return failureIDs;
};
