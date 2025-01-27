// @ts-check
const { BigNumber } = require('bignumber.js');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const pino = require('pino');
const axios = require('axios').default;
const { wait } = require('../utils.js');

const logger = pino();
const loggerOptions = {
  crawler: 'ranking',
};

async function getThousandValidators() {
  try {
    const response = await axios.get('https://kusama.w3f.community/candidates');
    return response.data;
  } catch (error) {
    logger.error(loggerOptions, `Error fetching Thousand Validator Program stats: ${JSON.stringify(error)}`);
    return [];
  }
}

function isVerifiedIdentity(identity) {
  if (identity.judgements.length === 0) {
    return false;
  }
  return identity.judgements
    .filter(([, judgement]) => !judgement.isFeePaid)
    .some(([, judgement]) => judgement.isKnownGood || judgement.isReasonable);
}

function getName(identity) {
  if (
    identity.displayParent
    && identity.displayParent !== ''
    && identity.display
    && identity.display !== ''
  ) {
    return `${identity.displayParent}/${identity.display}`;
  }
  return identity.display || '';
}

function getClusterName(identity) {
  return identity.displayParent || '';
}

function subIdentity(identity) {
  if (
    identity.displayParent
    && identity.displayParent !== ''
    && identity.display
    && identity.display !== ''
  ) {
    return true;
  }
  return false;
}

function getIdentityRating(name, verifiedIdentity, hasAllFields) {
  if (verifiedIdentity && hasAllFields) {
    return 3;
  } if (verifiedIdentity && !hasAllFields) {
    return 2;
  } if (name !== '') {
    return 1;
  }
  return 0;
}

function parseIdentity(identity) {
  const verifiedIdentity = isVerifiedIdentity(identity);
  const hasSubIdentity = subIdentity(identity);
  const name = getName(identity);
  const hasAllFields = identity.display
    && identity.legal
    && identity.web
    && identity.email
    && identity.twitter
    && identity.riot;
  const identityRating = getIdentityRating(name, verifiedIdentity, hasAllFields);
  return {
    verifiedIdentity,
    hasSubIdentity,
    name,
    identityRating,
  };
}

function getCommissionHistory(accountId, erasPreferences) {
  const commissionHistory = [];
  erasPreferences.forEach(({ era, validators }) => {
    if (validators[accountId]) {
      commissionHistory.push({
        era: new BigNumber(era.toString()).toString(10),
        commission: (validators[accountId].commission / 10000000).toFixed(2),
      });
    } else {
      commissionHistory.push({
        era: new BigNumber(era.toString()).toString(10),
        commission: null,
      });
    }
  });
  return commissionHistory;
}

function getCommissionRating(commission, commissionHistory) {
  if (commission !== 100 && commission !== 0) {
    if (commission > 10) {
      return 1;
    }
    if (commission >= 5) {
      if (
        commissionHistory.length > 1
        && commissionHistory[0] > commissionHistory[commissionHistory.length - 1]
      ) {
        return 3;
      }
      return 2;
    }
    if (commission < 5) {
      return 3;
    }
  }
  return 0;
}

function getPayoutRating(payoutHistory, config) {
  const pendingEras = payoutHistory.filter((era) => era.status === 'pending').length;
  if (pendingEras <= config.erasPerDay) {
    return 3;
  } if (pendingEras <= 3 * config.erasPerDay) {
    return 2;
  } if (pendingEras < 7 * config.erasPerDay) {
    return 1;
  }
  return 0;
}

function getClusterInfo(hasSubIdentity, validators, validatorIdentity) {
  if (!hasSubIdentity) {
    // string detection
    // samples: DISC-SOFT-01, BINANCE_KSM_9, SNZPool-1
    if (validatorIdentity.display) {
      const stringSize = 6;
      const clusterMembers = validators.filter(
        ({ identity }) => (identity.display || '').substring(0, stringSize)
            === validatorIdentity.display.substring(0, stringSize),
      ).length;
      const clusterName = validatorIdentity.display
        .replace(/\d{1,2}$/g, '')
        .replace(/-$/g, '')
        .replace(/_$/g, '');
      return {
        clusterName,
        clusterMembers,
      };
    }
    return {
      clusterName: '',
      clusterMembers: 0,
    };
  }

  const clusterMembers = validators.filter(
    ({ identity }) => identity.displayParent === validatorIdentity.displayParent,
  ).length;
  const clusterName = getClusterName(validatorIdentity);
  return {
    clusterName,
    clusterMembers,
  };
}

// taken from https://stackoverflow.com/questions/19269545/how-to-get-a-number-of-random-elements-from-an-array
function getRandom(arr, n) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

module.exports = {
  start: async (wsProviderUrl, pool, config, delayedStart = true) => {
    if (delayedStart) {
      logger.info(loggerOptions, `Delay ranking start for ${config.startDelay / 1000}s`);
      await wait(config.startDelay);
    }
    logger.info(loggerOptions, 'Starting ranking crawler');
    const startTime = new Date().getTime();
    const wsProvider = new WsProvider(wsProviderUrl);
    const clusters = [];

    //
    // data collection
    //

    try {
      // thousand validators program data
      logger.info(loggerOptions, 'Fetching thousand validator program validators');
      const thousandValidators = await getThousandValidators();
      logger.info(loggerOptions, `Got info from ${thousandValidators.length} validators of thousand validator program!`);

      // chain data
      logger.info(loggerOptions, 'Fetching data from chain');
      const api = await ApiPromise.create({ provider: wsProvider });
      const withActive = false;
      const erasHistoric = await api.derive.staking.erasHistoric(withActive);
      const chainCurrentEra = await api.query.staking.currentEra();
      const eraIndexes = erasHistoric.slice(
        Math.max(erasHistoric.length - config.historySize, 0),
      );
      const { maxNominatorRewardedPerValidator } = api.consts.staking;

      const stakingQueryFlags = {
        withDestination: false,
        withExposure: true,
        withLedger: true,
        withNominations: false,
        withPrefs: true,
      };

      let validators = [];
      let intentions = [];
      let maxPerformance = 0;
      let minPerformance = 0;

      const [
        { block },
        validatorAddresses,
        waitingInfo,
        nominators,
        councilVotes,
        erasPoints,
        erasPreferences,
        erasSlashes,
        proposals,
        referendums,
      ] = await Promise.all([
        api.rpc.chain.getBlock(),
        api.query.session.validators(),
        api.derive.staking.waitingInfo(stakingQueryFlags),
        api.query.staking.nominators.entries(),
        api.derive.council.votes(),
        // eslint-disable-next-line no-underscore-dangle
        api.derive.staking._erasPoints(eraIndexes, withActive),
        // eslint-disable-next-line no-underscore-dangle
        api.derive.staking._erasPrefs(eraIndexes, withActive),
        // eslint-disable-next-line no-underscore-dangle
        api.derive.staking._erasSlashes(eraIndexes, withActive),
        api.derive.democracy.proposals(),
        api.derive.democracy.referendums(),
      ]);

      // get total stake by era
      let erasExposure = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const eraIndex of eraIndexes) {
        // eslint-disable-next-line no-await-in-loop
        const eraExposure = await api.derive.staking.eraExposure(eraIndex);
        erasExposure = erasExposure.concat(eraExposure);
      }

      validators = await Promise.all(
        validatorAddresses.map(
          (authorityId) => api.derive.staking.query(authorityId, stakingQueryFlags),
        ),
      );
      validators = await Promise.all(
        validators.map(
          (validator) => api.derive.accounts.info(validator.accountId).then(({ identity }) => ({
            ...validator,
            identity,
            active: true,
          })),
        ),
      );
      intentions = await Promise.all(
        waitingInfo.info.map(
          (intention) => api.derive.accounts.info(intention.accountId).then(({ identity }) => ({
            ...intention,
            identity,
            active: false,
          })),
        ),
      );
      const dataCollectionEndTime = new Date().getTime();
      const dataCollectionTime = dataCollectionEndTime - startTime;

      //
      // data processing
      //
      const blockHeight = parseInt(block.header.number.toString(), 10);
      const numActiveValidators = validatorAddresses.length;
      const eraPointsHistoryTotals = [];
      erasPoints.forEach(({ eraPoints }) => {
        eraPointsHistoryTotals.push(parseInt(eraPoints.toString(), 10));
      });
      const eraPointsHistoryTotalsSum = eraPointsHistoryTotals.reduce(
        (total, num) => total + num,
        0,
      );
      const eraPointsAverage = eraPointsHistoryTotalsSum / numActiveValidators;

      // dashboard metrics
      const activeValidatorCount = validatorAddresses.length;
      const waitingValidatorCount = waitingInfo.info.length;
      const nominatorCount = nominators.length;
      const currentEra = chainCurrentEra.toString();
      const nominatorStakes = [];
      // eslint-disable-next-line
      for (const validator of validators){
        // eslint-disable-next-line
        for (const nominatorStake of validator.exposure.others){
          nominatorStakes.push(nominatorStake.value);
        }
      }
      nominatorStakes.sort((a, b) => (
        (new BigNumber(a.toString()).lte(new BigNumber(b.toString())) ? 1 : 0)));
      const minimumStake = nominatorStakes[0];
      logger.info(loggerOptions, `${activeValidatorCount} active validators`);
      logger.info(loggerOptions, `${waitingValidatorCount} waiting validators`);
      logger.info(loggerOptions, `${nominatorCount} nominators`);
      logger.info(loggerOptions, `Current era is ${currentEra}`);
      logger.info(loggerOptions, `Minimum amount to stake is ${minimumStake}`);
      try {
        const sql = `UPDATE total SET count = '${activeValidatorCount}' WHERE name = 'active_validator_count'`;
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error updating total: ${JSON.stringify(error)}`);
      }
      try {
        const sql = `UPDATE total SET count = '${waitingValidatorCount}' WHERE name = 'waiting_validator_count'`;
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error updating total: ${JSON.stringify(error)}`);
      }
      try {
        const sql = `UPDATE total SET count = '${nominatorCount}' WHERE name = 'nominator_count'`;
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error updating total: ${JSON.stringify(error)}`);
      }
      try {
        const sql = `UPDATE total SET count = '${currentEra}' WHERE name = 'current_era'`;
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error updating total: ${JSON.stringify(error)}`);
      }
      try {
        const sql = `UPDATE total SET count = '${minimumStake}' WHERE name = 'minimum_stake'`;
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error updating total: ${JSON.stringify(error)}`);
      }

      // eslint-disable-next-line
      const nominations = nominators.map(([key, nominations]) => {
        const nominator = key.toHuman()[0];
        // eslint-disable-next-line
        const targets = nominations.toJSON()['targets'];
        return {
          nominator,
          targets,
        };
      });
      const participateInGovernance = [];
      proposals.forEach(({ seconds, proposer }) => {
        participateInGovernance.push(proposer.toString());
        seconds.forEach((accountId) => participateInGovernance.push(accountId.toString()));
      });
      referendums.forEach(({ votes }) => {
        votes.forEach(({ accountId }) => participateInGovernance.push(accountId.toString()));
      });
      validators = validators.concat(intentions);

      // stash address creation block
      const stashAddressesCreation = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const validator of validators) {
        // check stash
        const stashAddress = validator.stashId.toString();
        let sql = `SELECT block_number FROM event WHERE method = 'NewAccount' AND data LIKE '%${stashAddress}%'`;
        // eslint-disable-next-line no-await-in-loop
        let res = await pool.query(sql);
        if (res.rows.length > 0) {
          if (res.rows[0].block_number) {
            stashAddressesCreation[stashAddress] = res.rows[0].block_number;
          }
        } else {
          // if not found we assume that it's included in genesis
          stashAddressesCreation[stashAddress] = 0;
        }
        // check stash identity parent address
        if (validator.identity.parent) {
          const stashParentAddress = validator.identity.parent.toString();
          sql = `SELECT block_number FROM event WHERE method = 'NewAccount' AND data LIKE '%${stashParentAddress}%'`;
          // eslint-disable-next-line no-await-in-loop
          res = await pool.query(sql);
          if (res.rows.length > 0) {
            if (res.rows[0].block_number) {
              stashAddressesCreation[stashParentAddress] = res.rows[0].block_number;
            }
          } else {
            // if not found we assume that it's included in genesis
            stashAddressesCreation[stashParentAddress] = 0;
          }
        }
      }

      let ranking = validators
        .map((validator) => {
          // active
          const { active } = validator;
          const activeRating = active ? 2 : 0;

          // stash
          const stashAddress = validator.stashId.toString();

          // address creation
          let addressCreationRating = 0;
          const stashCreatedAtBlock = parseInt(stashAddressesCreation[stashAddress], 10);
          let stashParentCreatedAtBlock = 0;
          if (validator.identity.parent) {
            stashParentCreatedAtBlock = parseInt(
              stashAddressesCreation[validator.identity.parent.toString()], 10,
            );
            const best = stashParentCreatedAtBlock > stashCreatedAtBlock
              ? stashCreatedAtBlock
              : stashParentCreatedAtBlock;
            if (best <= blockHeight / 4) {
              addressCreationRating = 3;
            } else if (best <= (blockHeight / 4) * 2) {
              addressCreationRating = 2;
            } else if (best <= (blockHeight / 4) * 3) {
              addressCreationRating = 1;
            }
          } else if (stashCreatedAtBlock <= blockHeight / 4) {
            addressCreationRating = 3;
          } else if (stashCreatedAtBlock <= (blockHeight / 4) * 2) {
            addressCreationRating = 2;
          } else if (stashCreatedAtBlock <= (blockHeight / 4) * 3) {
            addressCreationRating = 1;
          }

          // thousand validators program
          const includedThousandValidators = thousandValidators.some(
            ({ stash }) => stash === stashAddress,
          );
          const thousandValidator = includedThousandValidators ? thousandValidators.find(
            ({ stash }) => stash === stashAddress,
          ) : '';

          // controller
          const controllerAddress = validator.controllerId.toString();

          // identity
          const {
            verifiedIdentity,
            hasSubIdentity,
            name,
            identityRating,
          } = parseIdentity(validator.identity);
          const identity = JSON.parse(JSON.stringify(validator.identity));

          // sub-accounts
          const { clusterMembers, clusterName } = getClusterInfo(
            hasSubIdentity,
            validators,
            validator.identity,
          );
          if (clusterName && !clusters.includes(clusterName)) {
            clusters.push(clusterName);
          }
          const partOfCluster = clusterMembers > 1;
          const subAccountsRating = hasSubIdentity ? 2 : 0;

          // nominators
          // eslint-disable-next-line
          const nominators = active
            ? validator.exposure.others.length
            : nominations.filter((nomination) => nomination.targets.some(
              (target) => target === validator.accountId.toString(),
            )).length;
          const nominatorsRating = nominators > 0
              && nominators <= maxNominatorRewardedPerValidator.toNumber()
            ? 2
            : 0;

          // slashes
          const slashes = erasSlashes.filter(
            // eslint-disable-next-line
            ({ validators }) => validators[validator.accountId.toString()],
          ) || [];
          const slashed = slashes.length > 0;
          const slashRating = slashed ? 0 : 2;

          // commission
          const commission = parseInt(
            validator.validatorPrefs.commission.toString(),
            10,
          ) / 10000000;
          const commissionHistory = getCommissionHistory(
            validator.accountId,
            erasPreferences,
          );
          const commissionRating = getCommissionRating(
            commission,
            commissionHistory,
          );

          // governance
          const councilBacking = validator.identity?.parent
            ? councilVotes.some(
              (vote) => vote[0].toString() === validator.accountId.toString(),
            )
              || councilVotes.some(
                (vote) => vote[0].toString() === validator.identity.parent.toString(),
              )
            : councilVotes.some(
              (vote) => vote[0].toString() === validator.accountId.toString(),
            );
          const activeInGovernance = validator.identity?.parent
            ? participateInGovernance.includes(validator.accountId.toString())
              || participateInGovernance.includes(
                validator.identity.parent.toString(),
              )
            : participateInGovernance.includes(validator.accountId.toString());
          let governanceRating = 0;
          if (councilBacking && activeInGovernance) {
            governanceRating = 3;
          } else if (councilBacking || activeInGovernance) {
            governanceRating = 2;
          }

          // era points and frecuency of payouts
          const eraPointsHistory = [];
          const payoutHistory = [];
          let activeEras = 0;
          let performance = 0;
          // eslint-disable-next-line
          erasPoints.forEach((eraPoints) => {
            const { era } = eraPoints;
            let eraPayoutState = 'inactive';
            let eraPerformance = 0;
            if (eraPoints.validators[stashAddress]) {
              activeEras += 1;
              const points = parseInt(eraPoints.validators[stashAddress].toString(), 10);
              eraPointsHistory.push({
                era: new BigNumber(era.toString()).toString(10),
                points,
              });
              if (validator.stakingLedger.claimedRewards.includes(era)) {
                eraPayoutState = 'paid';
              } else {
                eraPayoutState = 'pending';
              }
              // era performance
              const eraTotalStake = new BigNumber(
                erasExposure.find(
                  (eraExposure) => eraExposure.era === era,
                ).validators[stashAddress].total,
              );
              eraPerformance = (points * (1 - (commission / 100)))
                / (eraTotalStake.div(new BigNumber(10).pow(config.tokenDecimals)).toNumber());
            } else {
              // validator was not active in that era
              eraPointsHistory.push({
                era: new BigNumber(era.toString()).toString(10),
                points: 0,
              });
            }
            payoutHistory.push({
              era: new BigNumber(era.toString()).toString(10),
              status: eraPayoutState,
            });
            // total performance
            performance += eraPerformance;
          });
          const eraPointsHistoryValidator = eraPointsHistory.reduce(
            (total, era) => total + era.points,
            0,
          );
          const eraPointsPercent = (eraPointsHistoryValidator * 100) / eraPointsHistoryTotalsSum;
          const eraPointsRating = eraPointsHistoryValidator > eraPointsAverage ? 2 : 0;
          const payoutRating = getPayoutRating(payoutHistory, config);

          // stake
          const selfStake = active
            ? new BigNumber(validator.exposure.own.toString())
            : new BigNumber(validator.stakingLedger.total.toString());
          const totalStake = active
            ? new BigNumber(validator.exposure.total.toString())
            : selfStake;
          const otherStake = active
            ? totalStake.minus(selfStake)
            : new BigNumber(0);

          // performance
          if (performance > maxPerformance) {
            maxPerformance = performance;
          }
          if (performance < minPerformance) {
            minPerformance = performance;
          }

          const showClusterMember = true;

          // total rating
          const totalRating = activeRating
            + addressCreationRating
            + identityRating
            + subAccountsRating
            + nominatorsRating
            + commissionRating
            + eraPointsRating
            + slashRating
            + governanceRating
            + payoutRating;

          return {
            active,
            activeRating,
            name,
            identity,
            hasSubIdentity,
            subAccountsRating,
            verifiedIdentity,
            identityRating,
            stashAddress,
            stashCreatedAtBlock,
            stashParentCreatedAtBlock,
            addressCreationRating,
            controllerAddress,
            includedThousandValidators,
            thousandValidator,
            partOfCluster,
            clusterName,
            clusterMembers,
            showClusterMember,
            nominators,
            nominatorsRating,
            commission,
            commissionHistory,
            commissionRating,
            activeEras,
            eraPointsHistory,
            eraPointsPercent,
            eraPointsRating,
            performance,
            slashed,
            slashRating,
            slashes,
            councilBacking,
            activeInGovernance,
            governanceRating,
            payoutHistory,
            payoutRating,
            selfStake,
            otherStake,
            totalStake,
            totalRating,
          };
        })
        .sort((a, b) => (a.totalRating < b.totalRating ? 1 : -1))
        .map((validator, rank) => {
          const relativePerformance = ((validator.performance - minPerformance)
            / (maxPerformance - minPerformance)).toFixed(6);
          const dominated = false;
          return {
            rank: rank + 1,
            relativePerformance,
            ...validator,
            dominated,
          };
        });
      // find largest cluster size
      const largestCluster = Math.max(...Array.from(ranking, (o) => o.clusterMembers));
      logger.info(loggerOptions, `LARGEST cluster size is ${largestCluster}`);
      logger.info(loggerOptions, `SMALL cluster size is between 2 and ${Math.round(largestCluster / 3)}`);
      logger.info(loggerOptions, `MEDIUM cluster size is between ${Math.round(largestCluster / 3)} and ${(Math.round(largestCluster / 3) * 2)}`);
      logger.info(loggerOptions, `LARGE cluster size is between ${Math.round((largestCluster / 3) * 2)} and ${largestCluster}`);
      // find Pareto-dominated validators
      logger.info(loggerOptions, 'Finding dominated validators');
      const dominatedStart = new Date().getTime();
      ranking = ranking
        .map((validator) => {
          let dominated = false;
          // eslint-disable-next-line no-restricted-syntax
          for (const opponent of ranking) {
            if (
              opponent !== validator
              && (
                parseFloat(opponent.relativePerformance)
                  >= parseFloat(validator.relativePerformance)
                && opponent.selfStake.gte(validator.selfStake)
                && opponent.activeEras >= validator.activeEras
                && opponent.totalRating >= validator.totalRating
              )
            ) {
              dominated = true;
              break;
            }
          }
          return {
            ...validator,
            dominated,
          };
        });
      const dominatedEnd = new Date().getTime();
      logger.info(loggerOptions, `Found ${ranking.filter(({ dominated }) => dominated).length} dominated validators in ${((dominatedEnd - dominatedStart) / 1000).toFixed(3)}s`);

      // cluster categorization
      logger.info(loggerOptions, 'Random selection of validators to show from a cluster based on cluster size');
      let validatorsToHide = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const cluster of clusters) {
        const clusterMembers = ranking.filter(({ clusterName }) => clusterName === cluster);
        const clusterSize = clusterMembers[0].clusterMembers;
        // EXTRASMALL: 2 - Show all (2)
        let show = 2;
        if (clusterSize > 50) {
          // EXTRALARGE: 51-150 - Show 20% val. (up to 30)
          show = Math.floor(clusterSize * 0.2);
        } else if (clusterSize > 20) {
          // LARGE: 21-50 - Show 40% val. (up to 20)
          show = Math.floor(clusterSize * 0.4);
        } else if (clusterSize > 10) {
          // MEDIUM: 11-20 - Show 60% val. (up to 12)
          show = Math.floor(clusterSize * 0.6);
        } else if (clusterSize > 2) {
          // SMALL: 3-10 - Show 80% val. (up to 8)
          show = Math.floor(clusterSize * 0.8);
        }
        const hide = clusterSize - show;
        // randomly select 'hide' number of validators
        // from cluster and set 'showClusterMember' prop to false
        const rankingPositions = clusterMembers.map((validator) => validator.rank);
        validatorsToHide = validatorsToHide.concat(getRandom(rankingPositions, hide));
      }
      ranking = ranking
        .map((validator) => {
          const modValidator = validator;
          if (validatorsToHide.includes(validator.rank)) {
            modValidator.showClusterMember = false;
          }
          return modValidator;
        });
      logger.info(loggerOptions, `Finished, ${validatorsToHide.length} validators hided!`);

      logger.info(loggerOptions, `Storing ${ranking.length} validators in db...`);
      // eslint-disable-next-line no-restricted-syntax
      for (const validator of ranking) {
        const sql = `INSERT INTO ranking (
          block_height,
          rank,
          active,
          active_rating,
          name,
          identity,
          has_sub_identity,
          sub_accounts_rating,
          verified_identity,
          identity_rating,
          stash_address,
          stash_address_creation_block,
          stash_parent_address_creation_block,
          address_creation_rating,
          controller_address,
          included_thousand_validators,
          thousand_validator,
          part_of_cluster,
          cluster_name,
          cluster_members,
          show_cluster_member,
          nominators,
          nominators_rating,
          commission,
          commission_history,
          commission_rating,
          active_eras,
          era_points_history,
          era_points_percent,
          era_points_rating,
          performance,
          relative_performance,
          slashed,
          slash_rating,
          slashes,
          council_backing,
          active_in_governance,
          governance_rating,
          payout_history,
          payout_rating,
          self_stake,
          other_stake,
          total_stake,
          total_rating,
          dominated,
          timestamp
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $24,
          $25,
          $26,
          $27,
          $28,
          $29,
          $30,
          $31,
          $32,
          $33,
          $34,
          $35,
          $36,
          $37,
          $38,
          $39,
          $40,
          $41,
          $42,
          $43,
          $44,
          $45,
          $46
        )`;
        const data = [
          `${blockHeight}`,
          `${validator.rank}`,
          `${validator.active}`,
          `${validator.activeRating}`,
          `${validator.name}`,
          `${JSON.stringify(validator.identity)}`,
          `${validator.hasSubIdentity}`,
          `${validator.subAccountsRating}`,
          `${validator.verifiedIdentity}`,
          `${validator.identityRating}`,
          `${validator.stashAddress}`,
          `${validator.stashCreatedAtBlock}`,
          `${validator.stashParentCreatedAtBlock}`,
          `${validator.addressCreationRating}`,
          `${validator.controllerAddress}`,
          `${validator.includedThousandValidators}`,
          `${JSON.stringify(validator.thousandValidator)}`,
          `${validator.partOfCluster}`,
          `${validator.clusterName}`,
          `${validator.clusterMembers}`,
          `${validator.showClusterMember}`,
          `${validator.nominators}`,
          `${validator.nominatorsRating}`,
          `${validator.commission}`,
          `${JSON.stringify(validator.commissionHistory)}`,
          `${validator.commissionRating}`,
          `${validator.activeEras}`,
          `${JSON.stringify(validator.eraPointsHistory)}`,
          `${validator.eraPointsPercent}`,
          `${validator.eraPointsRating}`,
          `${validator.performance}`,
          `${validator.relativePerformance}`,
          `${validator.slashed}`,
          `${validator.slashRating}`,
          `${JSON.stringify(validator.slashes)}`,
          `${validator.councilBacking}`,
          `${validator.activeInGovernance}`,
          `${validator.governanceRating}`,
          `${JSON.stringify(validator.payoutHistory)}`,
          `${validator.payoutRating}`,
          `${validator.selfStake}`,
          `${validator.otherStake}`,
          `${validator.totalStake}`,
          `${validator.totalRating}`,
          `${validator.dominated}`,
          `${startTime}`,
        ];
        try {
          // eslint-disable-next-line no-await-in-loop
          await pool.query(sql, data);
        } catch (error) {
          logger.error(loggerOptions, `Error inserting data in ranking table: ${JSON.stringify(error)}`);
        }
      }
      logger.info(loggerOptions, 'Cleaning old data');
      const sql = `DELETE FROM ranking WHERE block_height != '${blockHeight}';`;
      try {
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error deleting old data ranking table: ${JSON.stringify(error)}`);
      }
      logger.info(loggerOptions, 'Disconnecting from API');
      await api.disconnect().catch((error) => logger.error(loggerOptions, `Disconnect error: ${JSON.stringify(error)}`));
      const endTime = new Date().getTime();
      const dataProcessingTime = endTime - dataCollectionEndTime;
      logger.info(loggerOptions, `Added ${ranking.length} validators in ${((dataCollectionTime + dataProcessingTime) / 1000).toFixed(3)}s`);
      logger.info(loggerOptions, `Next execution in ${(config.pollingTime / 60000).toFixed(0)}m...`);
    } catch (error) {
      logger.error(loggerOptions, `General error in ranking crawler: ${JSON.stringify(error)}`);
    }
    setTimeout(
      () => module.exports.start(wsProviderUrl, pool, config, false),
      config.pollingTime,
    );
  },
};
