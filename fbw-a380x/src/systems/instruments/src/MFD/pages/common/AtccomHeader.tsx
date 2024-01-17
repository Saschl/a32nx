import { FSComponent, Subject, VNode } from '@microsoft/msfs-sdk';
import { AbstractHeader } from 'instruments/src/MFD/pages/common/AbstractHeader';
import { PageSelectorDropdownMenu } from 'instruments/src/MFD/pages/common/PageSelectorDropdownMenu';

/*
 * Complete header for the ATCCOM system
 */
export class AtccomHeader extends AbstractHeader {
    private connectIsSelected = Subject.create(false);

    private requestIsSelected = Subject.create(false);

    private reportModifyIsSelected = Subject.create(false);

    private msgRecordIsSelected = Subject.create(false);

    private atisIsSelected = Subject.create(false);

    private emerIsSelected = Subject.create(false);

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        this.subs.push(this.props.mfd.uiService.activeUri.sub((val) => {
            this.connectIsSelected.set(val.category === 'connect');
            this.requestIsSelected.set(val.category === 'request');
            this.reportModifyIsSelected.set(val.category === 'report-modify');
            this.msgRecordIsSelected.set(val.category === 'msg-record');
            this.atisIsSelected.set(val.category === 'atis');
            this.emerIsSelected.set(val.category === 'emer');
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
                {super.render()}
                <div class="mfd-header-page-select-row">
                    <PageSelectorDropdownMenu
                        isActive={this.connectIsSelected}
                        label="CONNECT"
                        menuItems={[
                            { label: 'NOTIFICATION', action: () => this.props.mfd.uiService.navigateTo('atccom/connect/notification') },
                            { label: 'CONNECTION STATUS', action: () => this.props.mfd.uiService.navigateTo('atccom/connect/conn-status') },
                            { label: 'MAX UPLINK DELAY', action: () => this.props.mfd.uiService.navigateTo('atccom/connect/max-uplink-delay') }]}
                        idPrefix="pageSelectorConnect"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.requestIsSelected}
                        label="REQUEST"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('atccom/request') }]}
                        idPrefix="pageSelectorRequest"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.reportModifyIsSelected}
                        label="REPORTY & MODIFY"
                        menuItems={[
                            { label: 'POSITION', action: () => this.props.mfd.uiService.navigateTo('atccom/report-modify/position') },
                            { label: 'MODIFY', action: () => this.props.mfd.uiService.navigateTo('atccom/report-modify/modify') },
                            { label: 'OTHER REPORTS', action: () => this.props.mfd.uiService.navigateTo('atccom/report-modify/other-reports') },
                        ]}
                        idPrefix="pageSelectorReportModify"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.msgRecordIsSelected}
                        label="MSG RECORD"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('atccom/msg-record') }]}
                        idPrefix="pageSelectorMsgRecord"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.atisIsSelected}
                        label="ATIS"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('atccom/atis') }]}
                        idPrefix="pageSelectorAtis"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.emerIsSelected}
                        label="EMER"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('atccom/emer') }]}
                        idPrefix="pageSelectorEmer"
                        containerStyle="flex: 1"
                    />
                </div>
            </>
        );
    }
}
