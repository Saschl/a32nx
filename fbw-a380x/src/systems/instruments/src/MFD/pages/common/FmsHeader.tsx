import { FSComponent, Subject, VNode } from '@microsoft/msfs-sdk';
import { AbstractHeader } from 'instruments/src/MFD/pages/common/AbstractHeader';
import { DropdownMenu } from 'instruments/src/MFD/pages/common/DropdownMenu';
import { PageSelectorDropdownMenu } from 'instruments/src/MFD/pages/common/PageSelectorDropdownMenu';

/*
 * Complete header for the FMS system
 */
export class FmsHeader extends AbstractHeader {
    private activeIsSelected = Subject.create(false);

    private positionIsSelected = Subject.create(false);

    private secIndexIsSelected = Subject.create(false);

    private dataIsSelected = Subject.create(false);

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        this.subs.push(this.props.uiService.activeUri.sub((val) => {
            this.activeIsSelected.set(val.category === 'active');
            this.positionIsSelected.set(val.category === 'position');
            this.secIndexIsSelected.set(val.category === 'sec' || val.category === 'sec1' || val.category === 'sec2' || val.category === 'sec3');
            this.dataIsSelected.set(val.category === 'data');
        }, true));
    }

    public destroy(): void {
        // Destroy all subscriptions to remove all references to this instance.
        this.subs.forEach((x) => x.destroy());

        super.destroy();
    }

    render(): VNode {
        return (
            <>
                <div style="display: flex; flex-direction: row; justify-content: space-between;">
                    <DropdownMenu
                        values={this.availableSystems}
                        selectedIndex={this.sysSelectorSelectedIndex}
                        idPrefix="sysSelectorDropdown"
                        freeTextAllowed={false}
                        onModified={(val) => this.changeSystem(val)}
                        containerStyle="width: 25%;"
                        alignLabels="flex-start"
                    />
                    <span class="mfd-label" style="width: 25%; text-align: left; padding: 8px 10px 0px 10px;">{this.props.callsign}</span>
                </div>
                <div style="display: flex; flex-direction: row;">
                    <PageSelectorDropdownMenu
                        isActive={this.activeIsSelected}
                        label="ACTIVE"
                        menuItems={[
                            { label: 'F-PLN', action: () => this.props.uiService.navigateTo('fms/active/f-pln') },
                            { label: 'PERF', action: () => this.props.uiService.navigateTo('fms/active/perf') },
                            { label: 'FUEL&LOAD', action: () => this.props.uiService.navigateTo('fms/active/fuel-load') },
                            { label: 'WIND', action: () => this.props.uiService.navigateTo('fms/active/wind') },
                            { label: 'INIT', action: () => this.props.uiService.navigateTo('fms/active/init') }]}
                        idPrefix="pageSelectorActive"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.positionIsSelected}
                        label="POSITION"
                        menuItems={[
                            { label: 'MONITOR', action: () => this.props.uiService.navigateTo('fms/position/monitor') },
                            { label: 'REPORT', action: () => this.props.uiService.navigateTo('fms/position/report') },
                            { label: 'NAVAIDS', action: () => this.props.uiService.navigateTo('fms/position/navaids') },
                            { label: 'IRS', action: () => this.props.uiService.navigateTo('fms/position/irs') },
                            { label: 'GPS', action: () => this.props.uiService.navigateTo('fms/position/gps') }]}
                        idPrefix="pageSelectorPosition"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.secIndexIsSelected}
                        label="SEC INDEX"
                        menuItems={[
                            { label: 'SEC 1', action: () => this.props.uiService.navigateTo('fms/sec1/init') },
                            { label: 'SEC 2', action: () => this.props.uiService.navigateTo('fms/sec2/init') },
                            { label: 'SEC 3', action: () => this.props.uiService.navigateTo('fms/sec3/init') }]}
                        idPrefix="pageSelectorSecIndex"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.dataIsSelected}
                        label="DATA"
                        menuItems={[
                            { label: 'STATUS', action: () => this.props.uiService.navigateTo('fms/data/status') },
                            { label: 'WAYPOINT', action: () => this.props.uiService.navigateTo('fms/data/waypoint') },
                            { label: 'NAVAID', action: () => this.props.uiService.navigateTo('fms/data/navaid') },
                            { label: 'ROUTE', action: () => this.props.uiService.navigateTo('fms/data/route') },
                            { label: 'AIRPORT', action: () => this.props.uiService.navigateTo('fms/data/airport') },
                            { label: 'PRINTER', action: () => this.props.uiService.navigateTo('fms/data/printer') }]}
                        idPrefix="pageSelectorData"
                        containerStyle="flex: 1"
                    />
                </div>
            </>
        );
    }
}
