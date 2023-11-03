// Copyright (c) 2021-2023 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { usePersistentProperty } from '@flybywiresim/fbw-sdk';

import React, { useMemo, useState } from 'react';
import { FailureGenContext, FailureGenData, setNewSetting } from 'instruments/src/EFB/Failures/FailureGenerators/RandomFailureGenEFB';
import { t } from 'instruments/src/EFB/translation';
import { ArrowDownRight, ArrowUpRight } from 'react-bootstrap-icons';
import { ButtonIcon, FailureGeneratorChoiceSetting, FailureGeneratorSingleSetting } from 'instruments/src/EFB/Failures/FailureGenerators/FailureGeneratorSettingsUI';

const settingName = 'EFB_FAILURE_GENERATOR_SETTING_ALTITUDE';
const additionalSetting = [2, 1, 2, 0, 80, 250];
const numberOfSettingsPerGenerator = 6;
const uniqueGenPrefix = 'A';
const genName = 'Altitude';
const alias = () => t('Failures.Generators.GenAlt');
const disableTakeOffRearm = false;

const AltitudeConditionIndex = 3;
const AltitudeMinIndex = 4;
const AltitudeMaxIndex = 5;

export const failureGenConfigAltitude: () => FailureGenData = () => {
    const [setting, setSetting] = usePersistentProperty(settingName);
    const [armedState, setArmedState] = useState<boolean[]>();
    const settings = useMemo(() => {
        const splitString = setting?.split(',');
        if (splitString) return splitString.map(((it: string) => parseFloat(it)));
        return [];
    }, [setting]);

    return {
        setSetting,
        settings,
        setting,
        numberOfSettingsPerGenerator,
        uniqueGenPrefix,
        additionalSetting,
        genName,
        alias,
        disableTakeOffRearm,
        generatorSettingComponents,
        armedState,
        setArmedState,
    };
};

const generatorSettingComponents = (genNumber: number, generatorSettings: FailureGenData, failureGenContext: FailureGenContext) => {
    const settings = generatorSettings.settings;
    const settingTable = [
        <FailureGeneratorChoiceSetting
            title={t('Failures.Generators.AltitudeCondition')}
            failureGenContext={failureGenContext}
            generatorSettings={generatorSettings}
            multiChoice={climbDescentMode}
            setNewSetting={setNewSetting}
            genIndex={genNumber}
            settingIndex={AltitudeConditionIndex}
            value={settings[genNumber * numberOfSettingsPerGenerator + AltitudeConditionIndex]}
        />,
        <FailureGeneratorSingleSetting
            title={t('Failures.Generators.AltitudeMin')}
            unit={t('Failures.Generators.feet')}
            min={settings[genNumber * numberOfSettingsPerGenerator + AltitudeMaxIndex] * 100}
            max={settings[genNumber * numberOfSettingsPerGenerator + AltitudeMinIndex]}
            value={100}
            mult={100}
            setNewSetting={setNewSetting}
            generatorSettings={generatorSettings}
            genIndex={genNumber}
            settingIndex={AltitudeMinIndex}
            failureGenContext={failureGenContext}
        />,
        <FailureGeneratorSingleSetting
            title={t('Failures.Generators.AltitudeMax')}
            unit={t('Failures.Generators.feet')}
            min={settings[genNumber * numberOfSettingsPerGenerator + AltitudeMinIndex] * 100}
            max={40000}
            value={settings[genNumber * numberOfSettingsPerGenerator + AltitudeMaxIndex]}
            mult={100}
            setNewSetting={setNewSetting}
            generatorSettings={generatorSettings}
            genIndex={genNumber}
            settingIndex={AltitudeMaxIndex}
            failureGenContext={failureGenContext}
        />,
    ];
    return settingTable;
};

const climbDescentMode: (ButtonIcon)[] = [
    {
        icon: (
            <>
                <ArrowUpRight />
            </>),
        settingVar: 0,
        setting: 'Climb',
    },
    {
        icon: (
            <>
                <ArrowDownRight />
            </>),
        settingVar: 1,
        setting: 'Descent',
    },
];
