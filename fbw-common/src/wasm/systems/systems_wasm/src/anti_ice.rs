#[cfg(not(target_arch = "wasm32"))]
use crate::msfs::legacy::trigger_key_event_ex1;
#[cfg(target_arch = "wasm32")]
use msfs::legacy::trigger_key_event_ex1;
use systems::shared::to_bool;

use crate::{ExecuteOn, MsfsAspectBuilder, Variable};
use std::error::Error;

use msfs::sys::{
    KEY_ANTI_ICE_TOGGLE_ENG1, KEY_ANTI_ICE_TOGGLE_ENG2, KEY_ANTI_ICE_TOGGLE_ENG3,
    KEY_ANTI_ICE_TOGGLE_ENG4, KEY_TOGGLE_STRUCTURAL_DEICE,
};

pub(super) fn engine_anti_ice(
    engine_count: usize,
) -> impl FnOnce(&mut MsfsAspectBuilder) -> Result<(), Box<dyn Error>> {
    move |builder: &mut MsfsAspectBuilder| {
        for engine_number in 1..=engine_count {
            builder.on_change(
                ExecuteOn::PostTick,
                vec![
                    Variable::named(&format!(
                        "BUTTON_OVHD_ANTI_ICE_ENG_{}_POSITION",
                        engine_number
                    )),
                    Variable::aircraft("ENG ANTI ICE", "bool", engine_number.try_into().unwrap()),
                ],
                Box::new(move |prev_values, new_values| {
                    let was_eng_anti_ice_push_button_on = to_bool(prev_values[0]);
                    let is_eng_anti_ice_push_button_on = to_bool(new_values[0]);
                    let is_eng_anti_ice_on = to_bool(new_values[1]);

                    let has_eng_anti_ice_button_changed =
                        was_eng_anti_ice_push_button_on != is_eng_anti_ice_push_button_on;
                    let eng_anti_ice_disagrees =
                        is_eng_anti_ice_on != is_eng_anti_ice_push_button_on;

                    if has_eng_anti_ice_button_changed && eng_anti_ice_disagrees {
                        let state = match is_eng_anti_ice_push_button_on {
                            true => 1,
                            false => 0,
                        };

                        match engine_number {
                            1 => trigger_key_event_ex1(KEY_ANTI_ICE_TOGGLE_ENG1, state, 0, 0, 0, 0),
                            2 => trigger_key_event_ex1(KEY_ANTI_ICE_TOGGLE_ENG2, state, 0, 0, 0, 0),

                            3 => trigger_key_event_ex1(KEY_ANTI_ICE_TOGGLE_ENG3, state, 0, 0, 0, 0),
                            4 => trigger_key_event_ex1(KEY_ANTI_ICE_TOGGLE_ENG4, state, 0, 0, 0, 0),
                            _ => (),
                        }
                    }
                }),
            );
        }

        Ok(())
    }
}

pub(super) fn wing_anti_ice() -> impl FnOnce(&mut MsfsAspectBuilder) -> Result<(), Box<dyn Error>> {
    move |builder: &mut MsfsAspectBuilder| {
        builder.on_change(
            ExecuteOn::PostTick,
            vec![
                Variable::named("PNEU_WING_ANTI_ICE_SYSTEM_ON"),
                //TODO: replace with a mechanism that detects actual air flow into anti-ice system
                Variable::named("PNEU_WING_ANTI_ICE_HAS_FAULT"),
                Variable::aircraft("STRUCTURAL DEICE SWITCH", "Bool", 0),
            ],
            Box::new(move |prev_values, new_values| {
                let was_wing_anti_ice_on = to_bool(prev_values[0]) && !to_bool(prev_values[1]);
                let is_wing_anti_ice_on = to_bool(new_values[0]) && !to_bool(new_values[1]);
                let is_deicing = to_bool(new_values[2]);

                let has_wing_anti_ice_changed = was_wing_anti_ice_on != is_wing_anti_ice_on;
                let structural_anti_ice_disagrees = is_deicing != is_wing_anti_ice_on;

                if has_wing_anti_ice_changed && structural_anti_ice_disagrees {
                    trigger_key_event_ex1(KEY_TOGGLE_STRUCTURAL_DEICE, 0, 0, 0, 0, 0)
                }
            }),
        );

        Ok(())
    }
}
