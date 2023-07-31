import { ComponentProps, DisplayComponent, FSComponent, Subject, Subscribable, Subscription, VNode } from '@microsoft/msfs-sdk';
import './style.scss';
import { DataEntryFormat } from 'instruments/src/MFD/pages/common/DataEntryFormats';

// eslint-disable-next-line max-len
export const emptyMandatoryCharacter = (selected: boolean) => `<svg width="16" height="23" viewBox="1 1 13 23"><polyline points="2,2 2,22 13,22 13,2 2,2" fill="none" stroke=${selected ? 'black' : '#e68000'} stroke-width="2" /></svg>`;

interface InputFieldProps<T> extends ComponentProps {
    dataEntryFormat: DataEntryFormat<T>;
    mandatory?: Subscribable<boolean>;
    disabled?: Subscribable<boolean>;
    canBeCleared?: Subscribable<boolean>;
    computedByFms?: Subscribable<boolean>;
    canOverflow?: boolean;
    value: Subject<T>;
    /**
     * If defined, this component does not update the value prop, but rather calls this method.
     */
    onModified?: (newValue: T) => void;
    onInput?: (newValue: string) => void; // Called for every character that is being typed
    handleFocusBlurExternally?: boolean;
    containerStyle?: string;
    alignText?: 'flex-start' | 'center' | 'flex-end';
}

/**
 * Input field for text or numbers
 */
export class InputField<T> extends DisplayComponent<InputFieldProps<T>> {
    // Make sure to collect all subscriptions here, otherwise page navigation doesn't work.
    private subs = [] as Subscription[];

    public topRef = FSComponent.createRef<HTMLDivElement>();

    public containerRef = FSComponent.createRef<HTMLDivElement>();

    private spanningDivRef = FSComponent.createRef<HTMLDivElement>();

    public textInputRef = FSComponent.createRef<HTMLSpanElement>();

    private caretRef = FSComponent.createRef<HTMLSpanElement>();

    private leadingUnit = Subject.create<string>(undefined);

    private trailingUnit = Subject.create<string>(undefined);

    private leadingUnitRef = FSComponent.createRef<HTMLSpanElement>();

    private trailingUnitRef = FSComponent.createRef<HTMLSpanElement>();

    private modifiedFieldValue = Subject.create<string>(null);

    private isFocused = Subject.create(false);

    private isValidating = Subject.create(false);

    private onNewValue() {
        // If currently editing, blur field
        this.textInputRef.getOrDefault().blur();
        // Reset modifiedFieldValue
        if (this.modifiedFieldValue.get() !== null) {
            this.modifiedFieldValue.set(null);
        }
        if (this.props.value.get()) {
            if (this.props.canOverflow === true) {
                // If item was overflowed, check whether overflow is still needed
                this.overflow(!(this.props.value.get().toString().length <= this.props.dataEntryFormat.maxDigits));
            }

            if (this.props.mandatory.get() === true) {
                this.textInputRef.getOrDefault().classList.remove('mandatory');
            }
        }
        this.updateDisplayElement();
    }

    private updateDisplayElement() {
        // If modifiedFieldValue.get() === null, render props' value
        if (this.modifiedFieldValue.get() === null) {
            if (!this.props.value.get()) {
                this.populatePlaceholders();
            } else {
                const [formatted, leadingUnit, trailingUnit] = this.props.dataEntryFormat.format(this.props.value.get());
                this.textInputRef.getOrDefault().innerText = formatted;
                this.leadingUnit.set(leadingUnit);
                this.trailingUnit.set(trailingUnit);
            }
        } else { // Else, render modifiedFieldValue
            const numDigits = this.props.dataEntryFormat.maxDigits;
            if (this.modifiedFieldValue.get().length < numDigits || this.isFocused.get() === false || this.props.canOverflow === true) {
                this.textInputRef.getOrDefault().innerText = this.modifiedFieldValue.get();
                this.caretRef.getOrDefault().innerText = '';
            } else {
                this.textInputRef.getOrDefault().innerText = this.modifiedFieldValue.get().slice(0, numDigits - 1);
                this.caretRef.getOrDefault().innerText = this.modifiedFieldValue.get().slice(numDigits - 1, numDigits);
            }
        }
    }

    // Called when the input field changes
    private onInput() {
        if (this.props.canOverflow === true && this.modifiedFieldValue.get().length === this.props.dataEntryFormat.maxDigits) {
            this.overflow(true);
        }

        if (this.props.onInput) {
            this.props.onInput(this.modifiedFieldValue.get());
        }
    }

    public overflow(overflow: boolean) {
        if (overflow === true) {
            this.topRef.instance.style.position = 'relative';
            this.topRef.instance.style.top = '0px';
            this.containerRef.instance.style.position = 'absolute';
            this.containerRef.instance.style.top = '-18px';
            this.containerRef.instance.style.zIndex = '5';
            const remainingWidth = 768 - 50 - this.containerRef.instance.getBoundingClientRect().left;
            this.containerRef.instance.style.width = `${remainingWidth}px`; // TODO extend to right edge
            this.containerRef.instance.style.border = '1px solid grey';
        } else {
            this.topRef.instance.style.position = null;
            this.topRef.instance.style.top = null;
            this.containerRef.instance.style.position = null;
            this.containerRef.instance.style.top = null;
            this.containerRef.instance.style.zIndex = null;
            this.containerRef.instance.style.width = null;
            this.containerRef.instance.style.border = null;

            if (this.props.containerStyle) {
                this.containerRef.instance.setAttribute('style', this.props.containerStyle);
            }
        }
    }

    private onKeyDown(ev: KeyboardEvent) {
        if (ev.keyCode === KeyCode.KEY_BACK_SPACE) {
            if (this.modifiedFieldValue.get() === null && this.props.canBeCleared.get() === true) {
                this.modifiedFieldValue.set('');
            } else if (this.modifiedFieldValue.get().length === 0) {
                // Do nothing
            } else {
                this.modifiedFieldValue.set(this.modifiedFieldValue.get().slice(0, -1));
            }

            this.onInput();
        }
    }

    private onKeyPress(ev: KeyboardEvent) {
        // Un-select the text
        this.textInputRef.getOrDefault().classList.remove('valueSelected');
        // ev.key is undefined, so we have to use the deprecated keyCode here
        const key = String.fromCharCode(ev.keyCode).toUpperCase();

        if (ev.keyCode !== KeyCode.KEY_ENTER) {
            if (this.modifiedFieldValue.get() === null) {
                this.modifiedFieldValue.set('');
                this.spanningDivRef.getOrDefault().style.justifyContent = 'flex-start';
            }

            if (this.modifiedFieldValue.get()?.length < this.props.dataEntryFormat.maxDigits || this.props.canOverflow === true) {
                this.modifiedFieldValue.set(`${this.modifiedFieldValue.get()}${key}`);
                this.caretRef.getOrDefault().style.display = 'inline';
            }

            this.onInput();
        } else {
            // Enter was pressed
            ev.preventDefault();

            if (this.props.handleFocusBlurExternally) {
                this.onBlur(true);
            } else {
                this.textInputRef.getOrDefault().blur();
            }
        }
    }

    public onFocus() {
        if (this.isValidating.get() === false && this.props.disabled.get() === false) {
            this.isFocused.set(true);
            this.textInputRef.getOrDefault().classList.add('valueSelected');
            this.textInputRef.getOrDefault().classList.add('editing');
            if (this.props.mandatory.get() === true) {
                this.textInputRef.getOrDefault().classList.remove('mandatory');
            }
            this.modifiedFieldValue.set(null);
            this.spanningDivRef.getOrDefault().style.justifyContent = this.props.alignText;
            this.updateDisplayElement();
        }
    }

    public async onBlur(validateAndUpdate: boolean = true) {
        this.isFocused.set(false);
        this.textInputRef.getOrDefault().classList.remove('valueSelected');
        this.caretRef.getOrDefault().style.display = 'none';
        this.updateDisplayElement();

        if (validateAndUpdate) {
            if (this.modifiedFieldValue.get() === null && this.props.value.get() !== null) {
                // Enter is pressed after no modification
                await this.validateAndUpdate(this.props.value.get().toString());
            } else {
                await this.validateAndUpdate(this.modifiedFieldValue.get());
            }
        }
        this.spanningDivRef.getOrDefault().style.justifyContent = this.props.alignText;
        this.textInputRef.getOrDefault().classList.remove('editing');
    }

    private populatePlaceholders() {
        const [formatted, unitLeading, unitTrailing] = this.props.dataEntryFormat.format(null);
        this.leadingUnit.set(unitLeading);
        this.trailingUnit.set(unitTrailing);

        if (this.props.mandatory.get() === true && this.props.disabled.get() === false) {
            this.textInputRef.getOrDefault().innerHTML = formatted.replace(/-/gi, emptyMandatoryCharacter(this.isFocused.get()));
        } else {
            this.textInputRef.getOrDefault().innerText = formatted;
        }
    }

    private async validateAndUpdate(input: string) {
        this.isValidating.set(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.modifiedFieldValue.set(null);
        const newValue = await this.props.dataEntryFormat.parse(input);

        if (this.props.onModified) {
            this.props.onModified(newValue);
        } else {
            this.props.value.set(newValue);
        }

        this.isValidating.set(false);
    }

    onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        // Optional props
        if (this.props.mandatory === undefined) {
            this.props.mandatory = Subject.create(false);
        }
        if (this.props.disabled === undefined) {
            this.props.disabled = Subject.create(false);
        }
        if (this.props.canBeCleared === undefined) {
            this.props.canBeCleared = Subject.create(true);
        }
        if (this.props.computedByFms === undefined) {
            this.props.computedByFms = Subject.create(false);
        }
        if (this.props.alignText === undefined) {
            this.props.alignText = 'flex-end';
        }
        if (this.props.handleFocusBlurExternally === undefined) {
            this.props.handleFocusBlurExternally = false;
        }
        if (this.props.canOverflow === undefined) {
            this.props.canOverflow = false;
        }

        // Aspect ratio for font: 2:3 WxH
        this.spanningDivRef.instance.style.minWidth = `${Math.round(this.props.dataEntryFormat.maxDigits * 27.0 / 1.5)}px`;

        // Align text

        // Hide caret
        this.caretRef.instance.style.display = 'none';
        this.caretRef.instance.innerText = '';

        this.subs.push(this.props.value.sub(() => this.onNewValue(), true));
        this.subs.push(this.modifiedFieldValue.sub(() => this.updateDisplayElement()));
        this.subs.push(this.isValidating.sub((val) => {
            if (val === true) {
                this.textInputRef.getOrDefault().classList.add('validating');
            } else {
                this.textInputRef.getOrDefault().classList.remove('validating');
            }
        }));
        this.subs.push(this.props.mandatory.sub((val) => {
            if (val === true) {
                this.textInputRef.getOrDefault().classList.add('mandatory');
            } else {
                this.textInputRef.getOrDefault().classList.remove('mandatory');
            }
            this.updateDisplayElement();
        }, true));

        this.subs.push(this.props.disabled.sub((val) => {
            if (val === true) {
                // Disable click listeners
                this.textInputRef.getOrDefault().tabIndex = null;

                this.containerRef.getOrDefault().classList.add('disabled');
                this.textInputRef.getOrDefault().classList.add('disabled');

                if (this.props.mandatory.get() === true) {
                    this.textInputRef.getOrDefault().classList.remove('mandatory');
                }
            } else {
                this.containerRef.getOrDefault().classList.remove('disabled');
                this.textInputRef.getOrDefault().classList.remove('disabled');

                if (this.props.mandatory.get() === true) {
                    this.textInputRef.getOrDefault().classList.add('mandatory');
                }
            }
            this.updateDisplayElement();
        }, true));

        this.subs.push(this.props.computedByFms.sub((val) => {
            if (val === true) {
                this.textInputRef.getOrDefault().classList.add('computedByFms');
            } else {
                this.textInputRef.getOrDefault().classList.remove('computedByFms');
            }
        }, true));

        if (this.props.dataEntryFormat.reFormatTrigger) {
            this.subs.push(this.props.dataEntryFormat.reFormatTrigger.sub(() => this.updateDisplayElement()));
        }

        this.textInputRef.instance.addEventListener('keypress', (ev) => this.onKeyPress(ev));
        this.textInputRef.instance.addEventListener('keydown', (ev) => this.onKeyDown(ev));

        if (!this.props.handleFocusBlurExternally) {
            this.textInputRef.instance.addEventListener('focus', () => this.onFocus());
            this.textInputRef.instance.addEventListener('blur', () => this.onBlur());
            this.spanningDivRef.instance.addEventListener('click', () => {
                this.textInputRef.instance.focus();
            });
            this.leadingUnitRef.instance.addEventListener('click', () => {
                this.textInputRef.instance.focus();
            });
            this.trailingUnitRef.instance.addEventListener('click', () => {
                this.textInputRef.instance.focus();
            });
        }
    }

    render(): VNode {
        return (
            <div
                ref={this.topRef}
                style="display: flex; flex-direction: row; justify-items: flex-start; align-items: baseline;"
            >
                <div ref={this.containerRef} class="mfd-input-field-container" style={`${this.props.containerStyle}`}>
                    <span ref={this.leadingUnitRef} class="mfd-label-unit mfd-unit-leading" style="align-self: center;">{this.leadingUnit}</span>
                    <div ref={this.spanningDivRef} style={`display: flex; flex: 1; flex-direction: row; align-self: center; align-items: center; justify-content: ${this.props.alignText};`}>
                        <span
                            ref={this.textInputRef}
                            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                            tabIndex={-1}
                            class="mfd-input-field-text-input"
                        >
                            .
                        </span>
                        <span ref={this.caretRef} class="mfd-input-field-caret" />
                    </div>
                    <span ref={this.trailingUnitRef} class="mfd-label-unit mfd-unit-trailing" style="align-self: center;">{this.trailingUnit}</span>
                </div>
            </div>
        );
    }
}
