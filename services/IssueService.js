/*
 * Copyright (c) 2017 TopCoder, Inc. All rights reserved.
 */
'use strict';

/**
 * This service processes incoming issue events.
 * Changes in 1.1:
 * - changes related to https://www.topcoder.com/challenges/30060466
 * @author TCSCODER
 * @version 1.1
 */
const _ = require('lodash');
const Joi = require('joi');
const MarkdownIt = require('markdown-it');
const config = require('config');
const logger = require('../utils/logger');
const errors = require('../utils/errors');
const constants = require('../constants');
const topcoderApiHelper = require('../utils/topcoder-api-helper');
const models = require('../models');
const dbHelper = require('../utils/db-helper');
const helper = require('../utils/helper');
const gitHubService = require('./GithubService');
const emailService = require('./EmailService');
const userService = require('./UserService');
const gitlabService = require('./GitlabService');
const eventService = require('./EventService');

const md = new MarkdownIt();

/**
 * Generate the contest url, given the challenge id
 * @param {String} challengeId The id of the challenge in topcoder
 * @returns {String} The topcoder url to access the challenge
 * @private
 */
function getUrlForChallengeId(challengeId) {
  return `${config.TC_URL}/challenges/${challengeId}`;
}

/**
 * Parse the prize from issue title.
 * @param {Object} issue the issue
 * @private
 */
function parsePrizes(issue) {
  const matches = issue.title.match(/(\$[0-9]+)(?=.*\])/g);

  if (!matches || matches.length === 0) {
    throw new Error(`Cannot parse prize from title: ${issue.title}`);
  }

  issue.prizes = _.map(matches, (match) => parseInt(match.replace('$', ''), 10));
  issue.title = issue.title.replace(/^(\[.*\])/, '').trim();
}

/**
 * check if challenge is exists for given issue in db/topcoder
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @returns {Object} the found db issue if exists
 * @private
 */
async function ensureChallengeExists(event, issue) {
  let dbIssue = dbHelper.scanOne(models.Issue, {
    number: issue.number,
    provider: issue.provider,
    repositoryId: issue.repositoryId
  });

  if (dbIssue && dbIssue.status === 'challenge_creation_pending') {
    throw errors.internalDependencyError(`Challenge for the updated issue ${issue.number} is creating, rescheduling this event`);
  }
  if (dbIssue && dbIssue.status === 'challenge_creation_failed') {
    // remove issue from db
    await dbHelper.remove(models.Issue, {
      number: issue.number,
      provider: issue.provider,
      repositoryId: issue.repositoryId
    });
    dbIssue = null;
  }

  if (!dbIssue) {
    await handleIssueCreate(event, issue);
    dbIssue = await dbHelper.scanOne(models.Issue, {
      number: issue.number,
      provider: issue.provider,
      repositoryId: issue.repositoryId
    });
  }
  return dbIssue;
}

/**
 * gets the project detail
 * @param {Object} issue the issue
 * @param {Object} event the event data
 * @returns {Object} the project detail
 * @private
 */
async function getProjectDetail(issue, event) {
  let fullRepoUrl;
  if (issue.provider === 'github') {
    fullRepoUrl = `https://github.com/${event.data.repository.full_name}`;
  } else if (issue.provider === 'gitlab') {
    fullRepoUrl = `${config.GITLAB_API_BASE_URL}/${event.data.repository.full_name}`;
  }
  const project = await dbHelper.scanOne(models.Project, {
    repoUrl: fullRepoUrl
  });

  return project;
}

/**
 * removes the current assignee if user is not found in topcoder X mapping.
 * user first need to sign up in Topcoder X
 * @param {Object} event the event
 * @param {Number} assigneeUserId the issue assignee id
 * @param {Object} issue the issue
 * @param {boolean} reOpen the flag whether to reopen the issue or not
 * @param {String} comment if any predefined message us there
 * @private
 */
async function rollbackAssignee(event, assigneeUserId, issue, reOpen = false, comment = null) {
  let assigneeUsername;
  if (event.provider === 'github') {
    assigneeUsername = await gitHubService.getUsernameById(event.copilot, assigneeUserId);
  } else {
    assigneeUsername = await gitlabService.getUsernameById(event.copilot, assigneeUserId);
  }

  if (!comment) {
    // comment on the git ticket for the user to self-sign up with the Topcoder x Self-Service tool
    comment = `@${assigneeUsername}, please sign-up with Topcoder X tool`;
  }

  if (event.provider === 'github') {
    await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
    // un-assign the user from the ticket
    await gitHubService.removeAssign(event.copilot, event.data.repository.full_name, issue.number, assigneeUsername);
  } else {
    await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
    // un-assign the user from the ticket
    await gitlabService.removeAssign(event.copilot, event.data.repository.id, issue.number, assigneeUserId);
  }
  if (reOpen) {
    await eventService.reOpenIssue(event, issue);
  }
}

/**
 * Parse the comments from issue comment.
 * @param {Object} comment the comment
 * @returns {Object} the parsed comment
 * @private
 */
function parseComment(comment) {
  const parsedComment = {};

  parsedComment.isBid = /\/bid/.test(comment.body);
  if (parsedComment.isBid) {
    // parse bid amount
    const amountWithCommand = comment.body.match(/\/bid[ \t]+\$[0-9]+/g);
    if (!amountWithCommand || amountWithCommand.length === 0) {
      throw new Error(`Cannot parse bid amount from comment: '${comment.body}'`);
    }
    const numberPart = amountWithCommand[0].match(/\$[0-9]+/g)[0].replace('$', '');
    parsedComment.bidAmount = parseInt(numberPart, 10);
  }

  parsedComment.isAcceptBid = /\/accept_bid/.test(comment.body);
  if (parsedComment.isAcceptBid) {
    // eslint-disable-next-line no-useless-escape
    const command = comment.body.match(/\/accept_bid[ \t]+\@([^\s]+)[ \t]+\$[0-9]+/g);
    if (!command || command.length === 0) {
      throw new Error('Accept bid command is not valid');
    }
    // parse the accepted user
    // any word after @ till first space
    parsedComment.assignedUser = command[0].match(/@([^\s]+)/g)[0].replace('@', '');
    // parse accepted bid amount
    const numberPart = command[0].match(/\$[0-9]+/g)[0].replace('$', '');
    logger.debug(`parsed dollar amount out as ${numberPart}`);
    parsedComment.acceptedBidAmount = parseInt(numberPart, 10);
  }
  return parsedComment;
}

/**
 * handles the issue assignment
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueAssignment(event, issue) {
  const assigneeUserId = event.data.assignee.id;
  logger.debug(`Looking up TC handle of git user: ${assigneeUserId}`);
  const userMapping = await userService.getTCUserName(event.provider, assigneeUserId);
  if (userMapping && userMapping.topcoderUsername) {
    let dbIssue;
    try {
      dbIssue = await ensureChallengeExists(event, issue);

      // ensure issue has open for pickup label
      const hasOpenForPickupLabel = _(issue.labels).includes(config.OPEN_FOR_PICKUP_ISSUE_LABEL); // eslint-disable-line lodash/chaining
      const hasNotReadyLabel = _(issue.labels).includes(config.NOT_READY_ISSUE_LABEL); // eslint-disable-line lodash/chaining
      if (!hasOpenForPickupLabel) {
        if (!issue.assignee) {
          const issueLabels = _(issue.labels).push(config.NOT_READY_ISSUE_LABEL).value(); // eslint-disable-line lodash/chaining
          const comment = `This ticket isn't quite ready to be worked on yet.Please wait until it has the ${config.OPEN_FOR_PICKUP_ISSUE_LABEL} label`;

          logger.debug(`Adding label ${config.NOT_READY_ISSUE_LABEL}`);
          if (event.provider === constants.USER_TYPES.GITLAB) { // eslint-disable-line max-depth
            await gitlabService.addLabels(event.copilot, event.data.repository.id, issue.number, issueLabels);
          } else {
            await gitHubService.addLabels(event.copilot, event.data.repository.full_name, issue.number, issueLabels);
          }

          await rollbackAssignee(event, assigneeUserId, issue, false, comment);
        } else {
          logger.debug('Does not has Open for pickup but has assignee, remain labels');
          if (event.provider === constants.USER_TYPES.GITLAB) { // eslint-disable-line max-depth
            await gitlabService.addLabels(event.copilot, event.data.repository.id, issue.number, issue.labels);
          } else {
            await gitHubService.addLabels(event.copilot, event.data.repository.full_name, issue.number, issue.labels);
          }

          if (!hasNotReadyLabel) { // eslint-disable-line max-depth
            const contestUrl = getUrlForChallengeId(dbIssue.challengeId);
            const comment = `Contest ${contestUrl} has been updated - ${userMapping.topcoderUsername} has been unassigned.`;
            await rollbackAssignee(event, assigneeUserId, issue, false, comment);
          } else {
            const comment = `This ticket isn't quite ready to be worked on yet. Please wait until it has the ${config.OPEN_FOR_PICKUP_ISSUE_LABEL} label`;
            await rollbackAssignee(event, assigneeUserId, issue, false, comment);
          }
        }
        return;
      }

      logger.debug(`Getting the topcoder member ID for member name: ${userMapping.topcoderUsername}`);
      const topcoderUserId = await topcoderApiHelper.getTopcoderMemberId(userMapping.topcoderUsername);
      // Update the challenge
      logger.debug(`Assigning user to challenge: ${userMapping.topcoderUsername}`);
      topcoderApiHelper.assignUserAsRegistrant(topcoderUserId, dbIssue.challengeId);
      dbIssue = await dbHelper.update(models.Issue, dbIssue.id, {
        assignee: issue.assignee,
        assignedAt: new Date(),
        updatedAt: new Date()
      });

      // remove open for pickup and add assigned
      const updateLabels = _(issue.labels)
        .filter((i) => i !== config.OPEN_FOR_PICKUP_ISSUE_LABEL)
        .push(config.ASSIGNED_ISSUE_LABEL)
        .value();

      if (event.provider === 'github') {
        await gitHubService.addLabels(event.copilot, event.data.repository.full_name, issue.number, updateLabels);
      } else {
        await gitlabService.addLabels(event.copilot, event.data.repository.id, issue.number, updateLabels);
      }
    } catch (err) {
      eventService.handleEventGracefully(event, issue, err);
      return;
    }
    const contestUrl = getUrlForChallengeId(dbIssue.challengeId);
    const comment = `Contest ${contestUrl} has been updated - it has been assigned to ${userMapping.topcoderUsername}.`;
    if (event.provider === 'github') {
      await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
    } else {
      await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
    }

    logger.debug(`Member ${userMapping.topcoderUsername} is assigned to challenge with id ${dbIssue.challengeId}`);
  } else {
    await rollbackAssignee(event, assigneeUserId, issue);
  }
}

/**
 * handles the issue comment event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueComment(event, issue) {
  const parsedComment = parseComment(event.data.comment);
  if (parsedComment.isBid) {
    logger.debug(`New bid is received with amount ${parsedComment.bidAmount}.`);
    await emailService.sendNewBidEmail(event.data, parsedComment.bidAmount);
  }
  if (parsedComment.isAcceptBid) {
    logger.debug(`Bid by ${parsedComment.assignedUser} is accepted with amount ${parsedComment.bidAmount} `);
    const newTitle = `[$${parsedComment.acceptedBidAmount}] ${issue.title}`;
    logger.debug(`updating issue: ${event.data.repository.name}/${issue.number}`);

    if (event.provider === 'github') {
      await gitHubService.updateIssue(event.copilot, event.data.repository.full_name, issue.number, newTitle);
    } else {
      await gitlabService.updateIssue(event.copilot, event.data.repository.id, issue.number, newTitle);
    }

    // assign user
    logger.debug(`assigning user, ${parsedComment.assignedUser} to issue: ${event.data.repository.name}/${issue.number}`);
    if (event.provider === 'github') {
      await gitHubService.assignUser(event.copilot, event.data.repository.full_name, issue.number, parsedComment.assignedUser);
    } else {
      const userId = await gitlabService.getUserIdByLogin(event.copilot, parsedComment.assignedUser);
      await gitlabService.assignUser(event.copilot, event.data.repository.id, issue.number, userId);
    }
  }
}

/**
 * handles the issue update event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueUpdate(event, issue) {
  let dbIssue;
  try {
    dbIssue = await ensureChallengeExists(event, issue);

    if (dbIssue.title === issue.title &&
      dbIssue.body === issue.body &&
      dbIssue.prizes.length === issue.prizes.length &&
      dbIssue.prizes[0] === issue.prizes[0]) {
      // Title, body, prizes doesn't change, just ignore
      logger.debug(`nothing changed for issue ${issue.number}`);
      return;
    }

    // Update the challenge
    await topcoderApiHelper.updateChallenge(dbIssue.challengeId, {
      name: issue.title,
      detailedRequirements: issue.body,
      prizes: issue.prizes
    });
    // Save
    await dbHelper.update(models.Issue, dbIssue.id, {
      title: issue.title,
      body: issue.body,
      prizes: issue.prizes,
      labels: issue.labels,
      assignee: issue.assignee,
      updatedAt: new Date()
    });
  } catch (e) {
    await eventService.handleEventGracefully(event, issue, e);
    return;
  }
  // comment on the git ticket for the user to self-sign up with the Topcoder x Self-Service tool
  const contestUrl = getUrlForChallengeId(dbIssue.challengeId);
  const comment = `Contest ${contestUrl} has been updated - the new changes has been updated for this ticket.`;
  if (event.provider === 'github') {
    await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
  } else {
    await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
  }

  logger.debug(`updated challenge ${dbIssue.challengeId} for for issue ${issue.number}`);
}


/**
 * handles the issue closed event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueClose(event, issue) {
  let dbIssue;
  try {
    dbIssue = await ensureChallengeExists(event, issue);
    if (!event.paymentSuccessful) {
      let closeChallenge = false;
      // if issue is closed without Fix accepted label
      if (!_.includes(event.data.issue.labels, config.FIX_ACCEPTED_ISSUE_LABEL)) {
        logger.debug(`This issue ${issue.number} is closed without fix accepted label.`);
        let comment = 'This ticket was not processed for payment. If you would like to process it for payment,';
        comment += ' please reopen it, add the ```' + config.FIX_ACCEPTED_ISSUE_LABEL + '``` label, and then close it again';// eslint-disable-line
        if (event.provider === 'github') {
          await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
        } else {
          await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
        }
        closeChallenge = true;
      }
      if (issue.prizes[0] === 0) {
        closeChallenge = true;
      }


      // if issue is closed without assignee then do nothing
      if (!event.data.assignee.id) {
        logger.debug(`This issue ${issue.number} doesn't have assignee so ignoring this event.`);
        return;
      }

      // if issue has paid label don't process further
      if (_.includes(event.data.issue.labels, config.PAID_ISSUE_LABEL)) {
        logger.debug(`This issue ${issue.number} is already paid with challenge ${dbIssue.challengeId}`);
        return;
      }

      logger.debug(`Looking up TC handle of git user: ${event.data.assignee.id}`);
      const assigneeMember = await userService.getTCUserName(event.provider, event.data.assignee.id);

      // no mapping is found for current assignee remove assign, re-open issue and make comment
      // to assignee to login with Topcoder X
      if (!(assigneeMember && assigneeMember.topcoderUsername)) {
        await rollbackAssignee(event, event.data.assignee.id, issue, true);
      }

      // get project detail from db
      const project = await getProjectDetail(issue, event);

      logger.debug(`Getting the billing account ID for project ID: ${project.tcDirectId}`);
      const accountId = await topcoderApiHelper.getProjectBillingAccountId(project.tcDirectId);

      logger.debug(`assigning the billing account id ${accountId} to challenge`);

      // adding assignees as well if it is missed/failed during update
      // prize needs to be again set after adding billing account otherwise it won't let activate
      const updateBody = {
        billingAccountId: accountId,
        prizes: issue.prizes
      };
      await topcoderApiHelper.updateChallenge(dbIssue.challengeId, updateBody);

      logger.debug(`Getting the topcoder member ID for member name: ${assigneeMember.topcoderUsername}`);
      const winnerId = await topcoderApiHelper.getTopcoderMemberId(assigneeMember.topcoderUsername);

      logger.debug(`Getting the topcoder member ID for copilot name : ${event.copilot.topcoderUsername}`);
      // get copilot tc user id
      const copilotTopcoderUserId = await topcoderApiHelper.getTopcoderMemberId(event.copilot.topcoderUsername);

      // role id 14 for copilot
      const copilotResourceBody = {
        roleId: 14,
        resourceUserId: copilotTopcoderUserId,
        phaseId: 0,
        addNotification: true,
        addForumWatch: true
      };
      await topcoderApiHelper.addResourceToChallenge(dbIssue.challengeId, copilotResourceBody);

      // adding reg
      await topcoderApiHelper.assignUserAsRegistrant(winnerId, dbIssue.challengeId);

      // activate challenge
      await topcoderApiHelper.activateChallenge(dbIssue.challengeId);
      if (closeChallenge) {
        logger.debug(`The associated challenge ${dbIssue.challengeId} is scheduled for cancel`);
        setTimeout(async () => {
          await topcoderApiHelper.cancelPrivateContent(dbIssue.challengeId);
          logger.debug(`The challenge ${dbIssue.challengeId} is deleted`);
        }, config.CANCEL_CHALLENGE_INTERVAL); //eslint-disable-line
        return;
      }
      logger.debug(`close challenge with winner ${assigneeMember.topcoderUsername}(${winnerId})`);
      await topcoderApiHelper.closeChallenge(dbIssue.challengeId, winnerId);
      event.paymentSuccessful = true;
    }
  } catch (e) {
    event.paymentSuccessful = event.paymentSuccessful === true; // if once paid shouldn't be false
    await eventService.handleEventGracefully(event, issue, e, event.paymentSuccessful);
    return;
  }
  try {
    logger.debug('update issue as paid');
    const labels = _(dbIssue.labels)
      .filter((i) => i !== config.OPEN_FOR_PICKUP_ISSUE_LABEL && i !== config.ASSIGNED_ISSUE_LABEL)
      .push(config.ASSIGNED_ISSUE_LABEL)
      .value();
    dbIssue = await dbHelper.update(models.Issue, dbIssue.id, {
      labels,
      updatedAt: new Date()
    });

    if (event.provider === 'github') {
      await gitHubService.markIssueAsPaid(event.copilot, event.data.repository.full_name, issue.number, dbIssue.challengeId, dbIssue.labels);
    } else {
      await gitlabService.markIssueAsPaid(event.copilot, event.data.repository.id, issue.number, dbIssue.challengeId, dbIssue.labels);
    }
  } catch (e) {
    await eventService.handleEventGracefully(event, issue, e, event.paymentSuccessful);
    return;
  }
}


/**
 * handles the issue create event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueCreate(event, issue) {
  // check if project for such repository is already created
  const project = await getProjectDetail(issue, event);

  if (!project) {
    throw new Error(
      'There is no project associated with this repository');
  }// if existing found don't create a project

  // Check if duplicated
  let dbIssue = await dbHelper.scanOne(models.Issue, {
    number: issue.number,
    provider: issue.provider,
    repositoryId: issue.repositoryId
  });

  if (dbIssue) {
    throw new Error(
      `Issue ${issue.number} is already in ${dbIssue.status}`);
  }

  // create issue with challenge creation pending
  const issueObject = _.assign({}, issue, {
    id: helper.generateIdentifier(),
    status: 'challenge_creation_pending'
  });
  dbIssue = await dbHelper.create(models.Issue, issueObject);

  const projectId = project.tcDirectId;
  logger.debug(`existing project was found with id ${projectId} for repository ${event.data.repository.full_name}`);
  try {
    // Create a new challenge
    issue.challengeId = await topcoderApiHelper.createChallenge({
      name: issue.title,
      projectId,
      detailedRequirements: issue.body,
      prizes: issue.prizes,
      task: true
    });

    // Save
    // update db payment
    await dbHelper.update(models.Issue, dbIssue.id, {
      challengeId: issue.challengeId,
      status: 'challenge_creation_successful',
      updatedAt: new Date()
    });
  } catch (e) {
    await dbHelper.remove(models.Issue, {
      number: issue.number,
      provider: issue.provider,
      repositoryId: issue.repositoryId
    });
    await eventService.handleEventGracefully(event, issue, e);
    return;
  }

  const contestUrl = getUrlForChallengeId(issue.challengeId);
  const comment = `Contest ${contestUrl} has been created for this ticket.`;
  if (event.provider === 'github') {
    await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
  } else {
    await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
  }
  if (event.provider === 'gitlab') {
    // if assignee is added during issue create then assign as well
    if (event.data.issue.assignees && event.data.issue.assignees.length > 0 && event.data.issue.assignees[0].id) {
      event.data.assignee = {
        id: event.data.issue.assignees[0].id
      };
      await handleIssueAssignment(event, issue);
    }
  }

  logger.debug(`new challenge created with id ${issue.challengeId} for issue ${issue.number}`);
}

/**
 * handles the issue label updated event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueLabelUpdated(event, issue) {
  let dbIssue;
  try {
    dbIssue = await ensureChallengeExists(event, issue);
  } catch (e) {
    await eventService.handleEventGracefully(event, issue, e);
    return;
  }
  await dbHelper.update(models.Issue, dbIssue.id, {
    labels: issue.labels,
    updatedAt: new Date()
  });
}

/**
 * handles the issue un assignment event
 * @param {Object} event the event
 * @param {Object} issue the issue
 * @private
 */
async function handleIssueUnAssignment(event, issue) {
  let dbIssue;
  try {
    dbIssue = await ensureChallengeExists(event, issue);
    if (dbIssue.assignee) {
      let assigneeUserId;
      if (event.provider === constants.USER_TYPES.GITHUB) {
        assigneeUserId = gitHubService.getUserIdByLogin(event.copilot, dbIssue.assignee);
      } else {
        assigneeUserId = await gitlabService.getUserIdByLogin(event.copilot, dbIssue.assignee);
      }
      logger.debug(`Looking up TC handle of git user: ${assigneeUserId}`);
      const userMapping = await userService.getTCUserName(event.provider, assigneeUserId);
      if (userMapping && userMapping.topcoderUsername) {
        // remove assigned and add open for pickup
        const updateLabels = _(issue.labels)
          .filter((i) => i !== config.ASSIGNED_ISSUE_LABEL)
          .push(config.OPEN_FOR_PICKUP_ISSUE_LABEL)
          .value();
        logger.debug(`Getting the topcoder member ID for member name: ${userMapping.topcoderUsername}`);
        const topcoderUserId = await topcoderApiHelper.getTopcoderMemberId(userMapping.topcoderUsername);
        // Update the challenge to remove the assignee
        logger.debug(`un-assigning user from challenge: ${userMapping.topcoderUsername}`);
        topcoderApiHelper.removeResourceToChallenge(dbIssue.challengeId, {
          roleId: 1,
          resourceUserId: topcoderUserId
        });
        const contestUrl = getUrlForChallengeId(dbIssue.challengeId);
        const comment = `Contest ${contestUrl} has been updated - ${userMapping.topcoderUsername} has been unassigned.`;
        if (event.provider === 'github') {
          await gitHubService.createComment(event.copilot, event.data.repository.full_name, issue.number, comment);
          await gitHubService.addLabels(event.copilot, event.data.repository.full_name, issue.number, updateLabels);
        } else {
          await gitlabService.createComment(event.copilot, event.data.repository.id, issue.number, comment);
          await gitlabService.addLabels(event.copilot, event.data.repository.id, issue.number, updateLabels);
        }
        logger.debug(`Member ${userMapping.topcoderUsername} is unassigned from challenge with id ${dbIssue.challengeId}`);
      }
    }
  } catch (e) {
    await eventService.handleEventGracefully(event, issue, e);
    return;
  }
  await dbHelper.update(models.Issue, dbIssue.id, {
    assignee: null,
    assignedAt: null,
    updatedAt: new Date()
  });
}

/**
 * Process issue event.
 * @param {Object} event the event
 */
async function process(event) {
  Joi.attempt(event, process.schema);

  const issue = {
    number: event.data.issue.number,
    title: event.data.issue.title,
    body: event.data.issue.body,
    provider: event.provider,
    repositoryId: event.data.repository.id,
    labels: event.data.issue.labels
  };
  let fullRepoUrl;
  if (event.provider === 'github') {
    fullRepoUrl = `https://github.com/${event.data.repository.full_name}`;
  } else if (event.provider === 'gitlab') {
    fullRepoUrl = `${config.GITLAB_API_BASE_URL}/${event.data.repository.full_name}`;
  }
  const project = await dbHelper.scanOne(models.Project, {
    repoUrl: fullRepoUrl
  });

  issue.projectId = project.id;

  // Parse prize from title
  parsePrizes(issue);
  const copilot = await userService.getRepositoryCopilot(event.provider, event.data.repository.full_name);
  event.copilot = copilot;

  // Markdown the body
  issue.body = md.render(_.get(issue, 'body', ''));

  if (event.data.issue.assignees && event.data.issue.assignees.length > 0 && event.data.issue.assignees[0].id) {
    if (event.provider === 'github') {
      issue.assignee = await gitHubService.getUsernameById(copilot, event.data.issue.assignees[0].id);
    } else if (event.provider === 'gitlab') {
      issue.assignee = await gitlabService.getUsernameById(copilot, event.data.issue.assignees[0].id);
    }
  }
  if (event.event === 'issue.created') {
    await handleIssueCreate(event, issue);
  } else if (event.event === 'issue.updated') {
    await handleIssueUpdate(event, issue);
  } else if (event.event === 'issue.closed') {
    await handleIssueClose(event, issue);
  } else if (event.event === 'comment.created' || event.event === 'comment.updated') {
    await handleIssueComment(event, issue);
  } else if (event.event === 'issue.assigned') {
    await handleIssueAssignment(event, issue);
  } else if (event.event === 'issue.labelUpdated') {
    await handleIssueLabelUpdated(event, issue);
  } else if (event.event === 'issue.unassigned') {
    await handleIssueUnAssignment(event, issue);
  }
}

process.schema = Joi.object().keys({
  event: Joi.string().valid('issue.created', 'issue.updated', 'issue.closed', 'comment.created', 'comment.updated', 'issue.assigned',
    'issue.labelUpdated', 'issue.unassigned').required(),
  provider: Joi.string().valid('github', 'gitlab').required(),
  data: Joi.object().keys({
    issue: Joi.object().keys({
      number: Joi.number().required(),
      title: Joi.string().required(),
      body: Joi.string().allow(''),
      labels: Joi.array().items(Joi.string()),
      assignees: Joi.array().items(Joi.object().keys({
        id: Joi.number().required()
      })),
      owner: Joi.object().keys({
        id: Joi.number().required()
      })
    }).required(),
    repository: Joi.object().keys({
      id: Joi.number().required(),
      name: Joi.string().required(),
      full_name: Joi.string().required()
    }).required(),
    comment: Joi.object().keys({
      id: Joi.number().required(),
      body: Joi.string().allow(''),
      user: Joi.object().keys({
        id: Joi.number().required()
      })
    }),
    assignee: Joi.object().keys({
      id: Joi.number().required().allow(null)
    }),
    labels: Joi.array().items(Joi.string())
  }).required(),
  retryCount: Joi.number().integer().default(0).optional(),
  paymentSuccessful: Joi.boolean().default(false).optional()
});


module.exports = {
  process
};

logger.buildService(module.exports);
