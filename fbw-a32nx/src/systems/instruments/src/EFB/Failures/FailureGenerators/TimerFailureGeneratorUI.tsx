import { useEffect, useMemo, useState } from 'react';
import { usePersistentProperty } from '@flybywiresim/fbw-sdk';
import { FailureGenContext, FailureGenData, FailureGenFeedbackEvent, setNewSetting } from 'instruments/src/EFB/Failures/FailureGenerators/RandomFailureGenEFB';
import { t } from 'instruments/src/EFB/translation';
import { FailureGeneratorSingleSetting } from 'instruments/src/EFB/Failures/FailureGenerators/FailureGeneratorSettingsUI';
import { EventBus } from '@microsoft/msfs-sdk';

const settingName = 'EFB_FAILURE_GENERATOR_SETTING_TIMER';
const additionalSetting = [2, 1, 2, 300, 600];
const numberOfSettingsPerGenerator = 5;
const uniqueGenPrefix = 'D';
const genName = 'Timer';
const alias = () => t('Failures.Generators.GenTimer');
const disableTakeOffRearm = false;

const DelayMinIndex = 3;
const DelayMaxIndex = 4;

export interface FailureGenTimerFeedbackEvent extends FailureGenFeedbackEvent{

}

const bus = new EventBus();

export const failureGenConfigTimer: () => FailureGenData = () => {
    const [setting, setSetting] = usePersistentProperty(settingName);
    const [expectedMode, setExpectedMode] = useState<number[]>();
    const [armedState, setArmedState] = useState<boolean[]>();
    const settings = useMemo(() => {
        const splitString = setting?.split(',');
        if (splitString) return splitString.map(((it: string) => parseFloat(it)));
        return [];
    }, [setting]);
    useEffect(() => {
        const sub1 = bus.getSubscriber<FailureGenTimerFeedbackEvent>().on('expectedMode').handle((table) => {
            setExpectedMode(table);
            console.info('received expectedMode');
        });
        const sub2 = bus.getSubscriber<FailureGenTimerFeedbackEvent>().on('armingDisplayStatus').handle((table) => {
            setArmedState(table);
            console.info('received received arming states');
        });
        return () => {
            sub1.destroy();
            sub2.destroy();
        };
    }, []);
    return {
        setSetting,
        settings,
        numberOfSettingsPerGenerator,
        uniqueGenPrefix,
        additionalSetting,
        genName,
        generatorSettingComponents,
        alias,
        disableTakeOffRearm,
        expectedMode,
        armedState,
    };
};

const generatorSettingComponents = (genNumber: number, generatorSettings: FailureGenData, failureGenContext: FailureGenContext) => {
    const settings = generatorSettings.settings;
    const settingTable = [
        FailureGeneratorSingleSetting(t('Failures.Generators.DelayAfterArmingMin'), t('Failures.Generators.seconds'), 0, settings[genNumber * numberOfSettingsPerGenerator + DelayMaxIndex],
            settings[genNumber * numberOfSettingsPerGenerator + DelayMinIndex], 1,
            setNewSetting, generatorSettings, genNumber, DelayMinIndex, failureGenContext),
        FailureGeneratorSingleSetting(t('Failures.Generators.DelayAfterArmingMax'), t('Failures.Generators.seconds'), settings[genNumber * numberOfSettingsPerGenerator + DelayMinIndex], 10000,
            settings[genNumber * numberOfSettingsPerGenerator + DelayMaxIndex], 1,
            setNewSetting, generatorSettings, genNumber, DelayMaxIndex, failureGenContext),
    ];
    return settingTable;
};
