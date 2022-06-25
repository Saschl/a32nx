//const { consoleSandbox } = require("@sentry/utils");

class PostIT_Edit extends BaseInstrument {
    constructor() {
        super();
        this.curTime = 0.0;
        this.needUpdate = false;
        this._isConnected = false;
        this.textFocused = false;
    }

    get templateID() {
        return "postit";
    }

    connectedCallback() {
        super.connectedCallback();

        this.unlockControls();

        const doc = document;

        this.textElem = doc.getElementById("text");
        this.invisElem = doc.getElementById("invis");
        this.taskbar = doc.getElementById("taskbar");
        this.typographyIcon = doc.getElementById("typography");
        this.closeIcon = doc.getElementById("close");
        this.paletteIcon = doc.getElementById("palette");
        this.pencilIcon = doc.getElementById("pencil");

        this.fonts = ['Caveat', 'Marker', 'Gochi', 'RockSalt', 'Kalam'];
        // IMPORTANT NOTE: The formatting of these strings is very important. (They MUST be defined as 'rgb(xxx, xxx, xxx)')
        this.penColors = ['rgb(0, 0, 0)', 'rgb(255, 0, 0)', 'rgb(22, 38, 76)', 'rgb(124, 51, 161)', 'rgb(212, 212, 212)'];
        this.pageColors = ['rgb(255, 255, 151)', 'rgb(251, 174, 74)', 'rgb(234, 236, 64)', 'rgb(242, 117, 173)', 'rgb(121, 203, 197)', 'rgb(177, 177, 177)'];

        this.splitIndex = 0;

        if (this.textElem) {
            NXDataStore.getAndSubscribe('POSTIT_ENABLED', (key, value) => {
                console.log("reloading postit!");
                super.reboot();
                this.fetchSimbriefData();
            }, '0');

            this.initMainLoop();
        }

        if (NXDataStore.get("POSTIT_FONT")) {
            this.textElem.style.fontFamily = NXDataStore.get("POSTIT_FONT");
        }

        if (NXDataStore.get("POSTIT_PAGE_COLOR")) {
            this.textElem.style.backgroundColor = NXDataStore.get("POSTIT_PAGE_COLOR");
            this.paletteIcon.style.stroke = NXDataStore.get("POSTIT_PAGE_COLOR");
        }

        if (NXDataStore.get("POSTIT_PEN_COLOR")) {
            this.textElem.style.color = NXDataStore.get("POSTIT_PEN_COLOR");
            this.pencilIcon.style.stroke = NXDataStore.get("POSTIT_PEN_COLOR");
        }

        const setProperties = (options, textElemProperty, iconElem, dataStoreKey) => {
            this.textElem.focus();
            const option = options[(options.indexOf(this.textElem.style[textElemProperty]) + 1) % options.length];
            this.textElem.style[textElemProperty] = option;

            if (iconElem) {
                iconElem.style.stroke = option;
            }

            NXDataStore.set(dataStoreKey, option);
        };

        this.paletteIcon.addEventListener("click", () => {
            setProperties(this.pageColors, "backgroundColor", this.paletteIcon, "POSTIT_PAGE_COLOR");
        });

        this.pencilIcon.addEventListener("click", () => {
            setProperties(this.penColors, "color", this.pencilIcon, "POSTIT_PEN_COLOR");
        });

        this.typographyIcon.addEventListener("click", () => {
            setProperties(this.fonts, "fontFamily", null, "POSTIT_FONT");
            this.invisElem.style.fontFamily = this.textElem.style.fontFamily;
        });

        this.closeIcon.addEventListener("click", () => {
            this.unlockControls();
            NXDataStore.set("POSTIT_CONTENT", this.textElem.value.substring(this.splitIndex));
            SimVar.SetSimVarValue("L:A32NX_MODEL_POSTIT_EDIT", "Bool", 0);
        });

        this.textElem.addEventListener("input", (e) => {
            console.log("event input fired, target:" + e.target);
            // The character being replaced is U+007f (DELETE Character)
            //this.textElem.value = this.textElem.value.replace(/\u007f/g, '');
            //if (e.target.value.length < this.splitIndex) {
            //    this.splitIndex = e.target.value.length;
            //}
        });

        //this.textElem.addEventListener("click", () => {
        //    console.log("textel focus (click), set focus, lock controls");
        //    this.lockControls();
        //    this.textElem.focus();
        //});

        this.textElem.addEventListener("keypress", (e) => {
            console.log("event keypress fired, value:" + e.target.value);
            // The character below is a one em-unit sized space
            this.invisElem.innerText = e.target.value + "\u2003";

            if (this.invisElem.clientHeight > 1000) {
                e.preventDefault();
            }
        });

        //        this.textElem.addEventListener("focus", () => {
        //            console.log("textel focus, set focus, lock controls");
        //            this.lockControls();
        //            //this.textElem.focus();
        //        });
    }

    lockControls() {
        Coherent.call("FOCUS_INPUT_FIELD");
        Coherent.trigger("FOCUS_INPUT_FIELD");
        console.log("controls locked, input field focused");
    }

    unlockControls() {
        Coherent.call("UNFOCUS_INPUT_FIELD");
        Coherent.trigger("UNFOCUS_INPUT_FIELD");
        console.log("controls unlocked, input field unfocused");
    }

    get isInteractive() {
        return true;
    }

    fetchSimbriefData() {
        const useSimbrief = SimVar.GetSimVarValue("L:A32NX_MODEL_POSTIT_SIMBRIEF", "Bool");
        const useBaro = NXDataStore.get("CONFIG_INIT_BARO_UNIT", "HPA");
        const simBriefUserId = NXDataStore.get("CONFIG_SIMBRIEF_USERID", "");
        const simBriefAPI = `https://www.simbrief.com/api/xml.fetcher.php?json=1&userid=${simBriefUserId}`;

        if (useSimbrief && simBriefUserId) {

            fetch(simBriefAPI)
                .then(response => response.json())
                .then(data => {

                    const {
                        origin: {
                            icao_code: data_origin
                        },
                        destination: {
                            icao_code: data_dest
                        },
                        general: {
                            passengers: data_pax,
                            initial_altitude: data_fl,
                            icao_airline: data_airline,
                            flight_number: data_flt_nr
                        }
                    } = data;

                    let data_qnh;

                    if (useBaro == "HPA") {
                        data_qnh = Math.trunc(SimVar.GetSimVarValue("AMBIENT PRESSURE", "millibar"));
                    } else {
                        data_qnh = SimVar.GetSimVarValue("AMBIENT PRESSURE", "inhg").toFixed(2);
                    }

                    const data_vitals = `FLT: ${data_airline}${data_flt_nr}\n${data_origin}/${data_dest}\nFL${data_fl.slice(0,-2)} QNH ${data_qnh}\nPAX ${data_pax}\n`;
                    this.splitIndex = data_vitals.length;

                    this.textElem.value = data_vitals + NXDataStore.get("POSTIT_CONTENT", "\nCLICK TO ADD!");
                    console.log("FETCHED AND INSERTED SIMBRIEF");
                });

        } else {

            this.textElem.value = NXDataStore.get("POSTIT_CONTENT", "\nCLICK TO ADD!");

        }
    }

    onFlightStart() {
        this.fetchSimbriefData();
    }

    initMainLoop() {
        const updateLoop = () => {
            if (!this._isConnected) {
                return;
            }
            this.Update();
            requestAnimationFrame(updateLoop);
        };
        this._isConnected = true;
        requestAnimationFrame(updateLoop);
    }

    disconnectedCallback() {
        this.unlockControls();
    }
}

registerInstrument("postit_edit-element", PostIT_Edit);
