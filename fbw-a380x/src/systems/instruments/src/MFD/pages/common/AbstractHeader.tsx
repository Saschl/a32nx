import { ArraySubject, DisplayComponent, FSComponent, Subject, Subscribable, Subscription, VNode } from '@microsoft/msfs-sdk';
import { AbstractMfdPageProps } from 'instruments/src/MFD/MFD';
import { DropdownMenu } from 'instruments/src/MFD/pages/common/DropdownMenu';

interface AbstractMfdHeaderProps extends AbstractMfdPageProps {
    activeFmsSource: Subscribable<'FMS 1' | 'FMS 2' | 'FMS 1-C' | 'FMS 2-C'>;
    callsign: Subscribable<string>;
}

/*
 * Complete header for the ATCCOM system
 */
export abstract class AbstractHeader extends DisplayComponent<AbstractMfdHeaderProps> {
    // Make sure to collect all subscriptions here, otherwise page navigation doesn't work.
    protected subs = [] as Subscription[];

    protected availableSystems = ArraySubject.create([this.props.activeFmsSource.get(), 'ATCCOM', 'SURV', 'FCU BKUP']);

    protected sysSelectorSelectedIndex = Subject.create(0);

    public changeSystem(selectedSysIndex: number) {
        this.sysSelectorSelectedIndex.set(selectedSysIndex);

        switch (selectedSysIndex) {
        case 0: // FMS
            this.props.mfd.uiService.navigateTo('fms/active/init');
            break;
        case 1: // ATCCOM
            this.props.mfd.uiService.navigateTo('atccom/connect');
            break;
        case 2: // SURV
            this.props.mfd.uiService.navigateTo('surv/controls');
            break;
        case 3: // FCU BKUP
            this.props.mfd.uiService.navigateTo('fcubkup/afs');
            break;

        default:
            this.props.mfd.uiService.navigateTo('fms/active/init');
            break;
        }
    }

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        this.subs.push(this.props.activeFmsSource.sub((val) => {
            this.availableSystems.removeAt(0);
            this.availableSystems.insert(val, 0);
        }, true));

        this.subs.push(this.props.mfd.uiService.activeUri.sub((val) => {
            switch (val.sys) {
            case 'fms':
                this.sysSelectorSelectedIndex.set(0);
                break;
            case 'atccom':
                this.sysSelectorSelectedIndex.set(1);
                break;
            case 'surv':
                this.sysSelectorSelectedIndex.set(2);
                break;
            case 'fcubkup':
                this.sysSelectorSelectedIndex.set(3);
                break;

            default:
                this.sysSelectorSelectedIndex.set(0);
                break;
            }
        }, true));
    }

    public destroy(): void {
        // Destroy all subscriptions to remove all references to this instance.
        this.subs.forEach((x) => x.destroy());

        super.destroy();
    }

    render(): VNode {
        return (
            <div class="mfd-header-sys-select-row">
                <DropdownMenu
                    values={this.availableSystems}
                    selectedIndex={this.sysSelectorSelectedIndex}
                    idPrefix="sysSelectorDropdown"
                    freeTextAllowed={false}
                    onModified={(val) => this.changeSystem(val)}
                    containerStyle="width: 25%;"
                    alignLabels="flex-start"
                />
                <span class="mfd-header-callsign">{this.props.callsign}</span>
            </div>
        );
    }
}
