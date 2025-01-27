<template>
  <div class="wallet-selector">
    <h2 class="text-center d-block">Select your address</h2>
    <hr />
    <div v-if="loading">
      <p class="py-4 text-center d-block">
        Loading addresses from extension...
      </p>
    </div>
    <div v-else>
      <b-table
        striped
        :fields="fields"
        :items="extensionAccounts"
        class="account-table"
      >
        <template #cell(address)="data">
          <Identicon :address="data.item.address" :size="24" />
          {{ shortAddress(data.item.address) }}
        </template>
        <template #cell(selected)="data">
          <b-button variant="info" @click="selectAddress(data.item.address)"
            >SELECT</b-button
          >
        </template>
      </b-table>
    </div>
  </div>
</template>

<script>
import { web3Accounts, web3Enable } from '@polkadot/extension-dapp'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { encodeAddress } from '@polkadot/keyring'
import Identicon from '@/components/Identicon.vue'
import commonMixin from '@/mixins/commonMixin.js'
import { config } from '@/config.js'

export default {
  components: { Identicon },
  mixins: [commonMixin],
  data() {
    return {
      config,
      detectedExtension: false,
      extensionAccounts: [],
      extensionAddresses: [],
      api: null,
      enableWeb3: false,
      error: null,
      noAccountsFound: true,
      loading: true,
      fields: [
        {
          key: 'address',
          label: 'Address',
        },
        {
          key: 'role',
          label: 'Role',
        },
        {
          key: 'available',
          label: 'Available balance',
        },
        {
          key: 'selected',
          label: '',
        },
      ],
    }
  },
  async created() {
    this.enableWeb3 = await web3Enable(
      `${config.title} for ${this.capitalize(config.name)}`
    )
      .then(() => {
        web3Accounts()
          .then((accounts) => {
            const wsProvider = new WsProvider(config.nodeWs)
            ApiPromise.create({ provider: wsProvider }).then(async (api) => {
              this.api = api
              if (accounts.length > 0) {
                this.detectedExtension = true
                for (const account of accounts) {
                  const address = encodeAddress(
                    account.address,
                    config.addressPrefix
                  )
                  const balances = await this.getAccountBalances(address)
                  this.extensionAccounts.push({
                    address,
                    role: await this.getAddressRole(address),
                    available: this.formatAmount(balances.availableBalance),
                    selected: false,
                  })
                }
                if (
                  this.extensionAccounts.length > 0 &&
                  this.extensionAddresses.length > 0
                ) {
                  this.noAccountsFound = false
                } else {
                  this.noAccountsFound = true
                }
                this.loading = false
              }
            })
          })
          .catch((error) => {
            // eslint-disable-next-line
            console.log('Error: ', error)
          })
      })
      .catch((error) => {
        // eslint-disable-next-line
        console.log('Error: ', error)
      })
  },
  methods: {
    async getAccountBalances(address) {
      const balances = await this.api.derive.balances.all(address)
      return balances
    },
    async getAddressRole(address) {
      const bonded = await this.api.query.staking.bonded(address)
      if (bonded.toString() && bonded.toString() === address) {
        return `stash/controller`
      } else if (bonded.toString() && bonded.toString() !== address) {
        return `stash`
      } else {
        const stakingLedger = await this.api.query.staking.ledger(address)
        if (stakingLedger.toString()) {
          return `controller`
        } else {
          return `none`
        }
      }
    },
    async selectAddress(address) {
      await this.$store.dispatch('ranking/updateSelectedAddress', address)
      this.$emit('close')
      return true
    },
  },
}
</script>

<style>
.wallet-selector {
  color: gray;
}
.account-table {
  color: gray;
}
</style>
