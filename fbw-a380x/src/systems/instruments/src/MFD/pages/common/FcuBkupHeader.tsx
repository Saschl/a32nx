import { FSComponent, Subject, VNode } from '@microsoft/msfs-sdk';
import { AbstractHeader } from 'instruments/src/MFD/pages/common/AbstractHeader';
import { PageSelectorDropdownMenu } from 'instruments/src/MFD/pages/common/PageSelectorDropdownMenu';

/*
 * Complete header for the FCU BKUP system
 */
export class FcuBkupHeader extends AbstractHeader {
    private afsIsSelected = Subject.create(false);

    private efisIsSelected = Subject.create(false);

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        this.subs.push(this.props.mfd.uiService.activeUri.sub((val) => {
            this.afsIsSelected.set(val.category === 'afs');
            this.efisIsSelected.set(val.category === 'efis');
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
                <div class="mfd-header-page-select-row" style="width: 50%">
                    <PageSelectorDropdownMenu
                        isActive={this.afsIsSelected}
                        label="AFS CP"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('fcubkup/afs') }]}
                        idPrefix="pageSelectorAfs"
                        containerStyle="flex: 1"
                    />
                    <PageSelectorDropdownMenu
                        isActive={this.efisIsSelected}
                        label="EFIS CP"
                        menuItems={[{ label: '', action: () => this.props.mfd.uiService.navigateTo('fcubkup/efis') }]}
                        idPrefix="pageSelectorEfis"
                        containerStyle="flex: 1"
                    />
                </div>
            </>
        );
    }
}
