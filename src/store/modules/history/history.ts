import { Module } from 'vuex'
import { RootState } from '@/store/types'
import { explorer_api, getAddressHistory } from '@/explorer_api'

import { HistoryState } from '@/store/modules/history/types'
import AvaHdWallet from '@/js/wallets/AvaHdWallet'
import { LedgerWallet } from '@/js/wallets/LedgerWallet'

const history_module: Module<HistoryState, RootState> = {
    namespaced: true,
    state: {
        isUpdating: false,
        transactions: [],
    },
    mutations: {
        clear(state) {
            state.transactions = []
        },
    },
    actions: {
        async updateTransactionHistory({ state, rootState, rootGetters, dispatch }) {
            let wallet = rootState.activeWallet
            if (!wallet) return

            // If wallet is still loading delay
            // @ts-ignore
            let network = rootState.Network.selectedNetwork

            if (!wallet.isInit) {
                setTimeout(() => {
                    dispatch('updateTransactionHistory')
                }, 500)
                return false
            }

            // can't update if there is no explorer or no wallet
            if (!network.explorerUrl || rootState.address === null) {
                return false
            }

            state.isUpdating = true

            let addresses: string[] = wallet.getHistoryAddresses()

            // this shouldnt ever happen, but to avoid getting every transaction...
            if (addresses.length === 0) {
                state.isUpdating = false
                return
            }

            let offset = 0
            let limit = 20

            // let t0 = performance.now()
            // let data = await getAddressHistory(addresses, limit, offset)

            getAddressHistory(addresses, limit, offset).then((data) => {
                let transactions = data.transactions
                state.transactions = transactions
                state.isUpdating = false
            })

            // let t1 = performance.now()
            // console.log('gethistory', t1 - t0)
            // let transactions = res.data.transactions;
            // let transactions = data.transactions
            //
            // state.transactions = transactions
            // state.isUpdating = false
        },
    },
}

export default history_module
