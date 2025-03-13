#[cfg(not(target_arch = "wasm32"))]
use crate::msfs::legacy::NamedVariableApi;
#[cfg(target_arch = "wasm32")]
use msfs::legacy::NamedVariableApi;

use fxhash::FxHashMap;

use systems::failures::FailureType;

pub(super) struct Failures {
    activate_sim_var: NamedVariableApi,
    deactivate_sim_var: NamedVariableApi,
    identifier_to_failure_type: FxHashMap<u64, FailureType>,
}
impl Failures {
    pub(super) fn new(
        activate_sim_var: NamedVariableApi,
        deactivate_sim_var: NamedVariableApi,
    ) -> Self {
        Self {
            activate_sim_var,
            deactivate_sim_var,
            identifier_to_failure_type: FxHashMap::default(),
        }
    }

    pub(super) fn add(&mut self, identifier: u64, failure_type: FailureType) {
        self.identifier_to_failure_type
            .insert(identifier, failure_type);
    }

    pub(super) fn read_failure_activate(&self) -> Option<FailureType> {
        self.read_failure(&self.activate_sim_var)
    }

    pub(super) fn read_failure_deactivate(&self) -> Option<FailureType> {
        self.read_failure(&self.deactivate_sim_var)
    }

    fn read_failure(&self, from: &NamedVariableApi) -> Option<FailureType> {
        let identifier: f64 = from.get();
        if let Some(failure_type) = self.identifier_to_failure_type.get(&(identifier as u64)) {
            from.set(0.);
            Some(*failure_type)
        } else {
            None
        }
    }
}
