/*
 * Copyright (c) 2017 TopCoder, Inc. All rights reserved.
 */

/**
 * This module contains the helper methods to work with Topcoder APIs.
 *
 * Changes in 1.1:
 * - added support for switching topcoder dev and prod API through configuration
 * @author TCSCODER
 * @version 1.1
 */
'use strict';

const jwtDecode = require('jwt-decode');
const axios = require('axios');
const config = require('config');
const _ = require('lodash');
const moment = require('moment');
const circularJSON = require('circular-json');

let topcoderApiProjects = require('topcoder-api-projects');
let topcoderApiChallenges = require('topcoder-api-challenges');

const topcoderDevApiProjects = require('topcoder-dev-api-projects');
const topcoderDevApiChallenges = require('topcoder-dev-api-challenges');

const logger = require('./logger');
const loggerFile = require('./logger-file');
const errors = require('./errors');


if (config.TC_DEV_ENV) {
  topcoderApiProjects = topcoderDevApiProjects;
  topcoderApiChallenges = topcoderDevApiChallenges;
}

// Cache the access token
let cachedAccessToken;

// Init the API instances
const projectsClient = topcoderApiProjects.ApiClient.instance;
const challengesClient = topcoderApiChallenges.ApiClient.instance;
const bearer = projectsClient.authentications.bearer;
bearer.apiKeyPrefix = 'Bearer';
challengesClient.authentications.bearer = bearer;
const projectsApiInstance = new topcoderApiProjects.DefaultApi();
const challengesApiInstance = new topcoderApiChallenges.DefaultApi();

/**
 * Authenticate with Topcoder API and get the access token.
 * @returns {String} the access token issued by Topcoder
 * @private
 */
async function getAccessToken() {
  // Check the cached access token
  if (cachedAccessToken) {
    const decoded = jwtDecode(cachedAccessToken);
    if (decoded.iat > new Date().getTime()) {
      // Still not expired, just use it
      return cachedAccessToken;
    }
  }

  // Authenticate
  const v2Response = await axios.post(config.TC_AUTHN_URL, config.TC_AUTHN_REQUEST_BODY);
  const v2IdToken = _.get(v2Response, 'data.id_token');
  const v2RefreshToken = _.get(v2Response, 'data.refresh_token');

  if (!v2IdToken || !v2RefreshToken) {
    throw new Error(`cannot authenticate with topcoder: ${config.TC_AUTHN_URL}`);
  }

  // Authorize
  const v3Response = await axios.post(
    config.TC_AUTHZ_URL, {
      param: {
        externalToken: v2IdToken,
        refreshToken: v2RefreshToken
      }
    }, {
      headers: {
        authorization: `Bearer ${v2IdToken}`
      }
    });

  cachedAccessToken = _.get(v3Response, 'data.result.content.token');

  if (!cachedAccessToken) {
    throw new Error(`cannot authorize with topcoder: ${config.TC_AUTHZ_URL}`);
  }

  return cachedAccessToken;
}

/**
 * Create a new project.
 * @param {String} projectName the project name
 * @returns {Number} the created project id
 */
async function createProject(projectName) {
  bearer.apiKey = await getAccessToken();
  // eslint-disable-next-line new-cap
  const projectBody = new topcoderApiProjects.ProjectRequestBody.constructFromObject({
    projectName
  });
  try {
    const projectResponse = await new Promise((resolve, reject) => {
      projectsApiInstance.directProjectsPost(projectBody, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
    const statusCode = projectResponse.result ? projectResponse.result.status : null;
    loggerFile.info(`EndPoint: POST /direct/projects,  POST parameters: ${circularJSON.stringify(projectBody)},
    Status Code:${statusCode}, Response: ${circularJSON.stringify(projectResponse)}`);
    return _.get(projectResponse, 'result.content.projectId');
  } catch (err) {
    loggerFile.info(`EndPoint: POST /direct/projects, POST parameters: ${circularJSON.stringify(projectBody)},
    Status Code:null, Error: 'Failed to create project.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to create project.');
  }
}

/**
 * Create a new challenge.
 * @param {Object} challenge the challenge to create
 * @returns {Number} the created challenge id
 */
async function createChallenge(challenge) {
  bearer.apiKey = await getAccessToken();
  const start = new Date();
  const startTime = moment(start).toISOString();
  const end = moment(start).add(config.NEW_CHALLENGE_DURATION_IN_DAYS, 'days').toISOString();

  // eslint-disable-next-line new-cap
  const challengeBody = new topcoderApiChallenges.NewChallengeBodyParam.constructFromObject({
    param: _.assign({}, config.NEW_CHALLENGE_TEMPLATE, {
      registrationStartDate: start,
      registrationStartsAt: startTime,
      registrationEndsAt: end,
      submissionEndsAt: end
    }, challenge)
  });
  try {
    const challengeResponse = await new Promise((resolve, reject) => {
      challengesApiInstance.saveDraftContest(challengeBody, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
    const statusCode = challengeResponse.result ? challengeResponse.result.status : null;
    loggerFile.info(`EndPoint: POST /challenges,  POST parameters: ${circularJSON.stringify(challengeBody)},
    Status Code:${statusCode}, Response: ${circularJSON.stringify(challengeResponse.result)}`);
    return _.get(challengeResponse, 'result.content.id');
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges,  POST parameters: ${circularJSON.stringify(challengeBody)}, Status Code:null,
    Error: 'Failed to create challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to create challenge.');
  }
}

/**
 * Update a challenge.
 * @param {Number} id the challenge id
 * @param {Object} challenge the challenge to update
 */
async function updateChallenge(id, challenge) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`Updating challenge ${id} with ${circularJSON.stringify(challenge)}`);
  // eslint-disable-next-line new-cap
  const challengeBody = new topcoderApiChallenges.UpdateChallengeBodyParam.constructFromObject({
    param: challenge
  });
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.challengesIdPut(id, challengeBody, (err, res) => {
        if (err) {
          logger.error(err);
          logger.debug(circularJSON.stringify(err));
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: PUT /challenges/${id},  PUT parameters: null, Status Code:${statusCode}, Response: ${circularJSON.stringify(response)}`);
  } catch (err) {
    loggerFile.info(`EndPoint: PUT /challenges/${id},  PUT parameters: null, Status Code:null,
    Error: 'Failed to update challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to update challenge.');
  }
}

/**
 * activates the topcoder challenge
 * @param {Number} id the challenge id
 */
async function activateChallenge(id) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`Activating challenge ${id}`);
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.activateChallenge(id, (err, data) => {
        if (err) {
          logger.error(err);
          logger.debug(circularJSON.stringify(err));
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: POST /challenges/${id}/activate,
    POST parameters: null, Status Code:${statusCode}, Response: ${circularJSON.stringify(response)}`);
    logger.debug(`Challenge ${id} is activated successfully.`);
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges/${id}/activate,  POST parameters: null, Status Code:null,
    Error: 'Failed to activate challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to activate challenge.');
  }
}

/**
 * Get challenge details by id
 * @param {Number} id challenge ID
 * @returns {Object} topcoder challenge
 */
async function getChallengeById(id) {
  if (!_.isNumber(id)) {
    throw new Error('The challenge id must valid number');
  }
  const apiKey = await getAccessToken();
  logger.debug('Getting topcoder challenge details');
  try {
    const response = await axios.get(`${projectsClient.basePath}/challenges/${id}`, {
      authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    });
    const challenge = _.get(response, 'data.result.content');
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: GET challenges/${id},  GET parameters: null, Status Code:${statusCode}, Response: ${circularJSON.stringify(response)}`);
    return challenge;
  } catch (err) {
    loggerFile.info(`EndPoint: GET challenges/${id},  GET parameters: null, Status Code:null,
    Error: 'Failed to get challenge details by Id', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to get challenge details by Id');
  }
}

/**
 * closes the topcoder challenge
 * @param {Number} id the challenge id
 * @param {Number} winnerId the winner id
 */
async function closeChallenge(id, winnerId) {
  const apiKey = await getAccessToken();
  logger.debug(`Closing challenge ${id}`);
  try {
    const response = await axios.post(`${projectsClient.basePath}/challenges/${id}/close?winnerId=${winnerId}`, null, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    const statusCode = response ? response.status : null;
    loggerFile.info(`EndPoint: POST /challenges/${id}/close,  POST parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
    logger.debug(`Challenge ${id} is closed successfully.`);
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges/${id}/close, POST parameters: null, Status Code:null,
    Error: 'Failed to close challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to close challenge.');
  }
}

/**
 * gets the project billing account id
 * @param {Number} id the project id
 * @returns {Number} the billing account id
 */
async function getProjectBillingAccountId(id) {
  const apiKey = await getAccessToken();
  logger.debug(`Getting project billing detail ${id}`);
  try {
    const response = await axios.get(`${projectsClient.basePath}/direct/projects/${id}`, {
      headers: {
        authorization: `Bearer ${apiKey}`
      }
    });
    const billingAccountId = _.get(response, 'data.result.content.billingAccountIds[0]');
    if (!billingAccountId) {
      _.set(response, 'data.result.content', `There is no billing account id associated with project ${id}`);
      throw new Error(response);
    }

    const statusCode = response ? response.status : null;
    loggerFile.info(`EndPoint: GET /direct/projects/${id},
    GET parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response.data)}`);
    return billingAccountId;
  } catch (err) {
    loggerFile.info(`EndPoint: GET /direct/projects/${id}, GET parameters: null, Status Code:null,
    Error: 'Failed to get billing detail for the project.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to get billing detail for the project.');
  }
}

/**
 * gets the topcoder user id from handle
 * @param {String} handle the topcoder handle
 * @returns {Number} the user id
 */
async function getTopcoderMemberId(handle) {
  bearer.apiKey = await getAccessToken();
  try {
    const response = await axios.get(`${projectsClient.basePath}/members/${handle}`);
    const statusCode = response ? response.status : null;
    loggerFile.info(`EndPoint: GET members/${handle},  GET parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response.data)}`);
    return _.get(response, 'data.result.content.userId');
  } catch (err) {
    loggerFile.info(`EndPoint: GET members/${handle}, GET parameters: null, Status Code:null,
    Error: 'Failed to get topcoder member id.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to get topcoder member id.');
  }
}

/**
 * adds the resource to the topcoder challenge
 * @param {Number} id the challenge id
 * @param {Object} resource the resource resource to add
 */
async function addResourceToChallenge(id, resource) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`adding resource to challenge ${id}`);
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.challengesIdResourcesPost(id, resource, (err, res) => {
        if (err) {
          if (_.get(JSON.parse(_.get(err, 'response.text')), 'result.content')
            === `User ${resource.resourceUserId} with role ${resource.roleId} already exists`) {
            resolve();
          } else {
            logger.error(circularJSON.stringify(err));
            reject(err);
          }
        } else {
          logger.debug(`resource is added to challenge ${id} successfully.`);
          resolve(res);
        }
      });
    });
    let statusCode = null;
    if (response && response.result) {
      statusCode = response.result.status;
    }
    loggerFile.info(`EndPoint: POST /challenges/${id}/resources,
    POST parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges/${id}/resources, POST parameters: null, Status Code:null,
    Error: 'Failed to add resource to the challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to add resource to the challenge.');
  }
}

/**
 * unregister user from topcoder challenge
 * @param {Number} id the challenge id
 * @param {Object} resource the resource  resource to remove
 */
async function unregisterUserFromChallenge(id) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`removing resource from challenge ${id}`);
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.unregisterChallenge(id, (err, res) => {
        if (err) {
          // TODO:* Handle when a user tries to unregister a user twice.
          // if (_.get(JSON.parse(_.get(err, 'response.text')), 'result.content')
          //   === `User ${resource.resourceUserId} with role ${resource.roleId} already exist`) {
          //   resolve(res);
          // } else {
          //   logger.error(circularJSON.stringify(err));
          //   reject(err);
          // }
          logger.debug(`Error - ${err}`);
          reject(err);
        } else {
          logger.debug(`user is removed from the challenge ${id} successfuly.`);
          resolve(res);
        }
      });
    });
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: POST /challenges/${id}/unregister,
    POST parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges/${id}/unregister, POST parameters: null, Status Code:null,
    Error: 'Failed to remove resource from the challenge', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to remove resource from the challenge');
  }
}

/**
 * cancels the private contents
 * @param {Number} id the challenge id
 */
async function cancelPrivateContent(id) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`Cancelling challenge ${id}`);
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.cancelPrivateContest(id, (err, data) => {
        if (err) {
          logger.error(err);
          logger.debug(circularJSON.stringify(err));
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    logger.debug(`Challenge ${id} is cancelled successfully.`);
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: POST /challenges/${id}/cancel,  POST parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
  } catch (err) {
    loggerFile.info(`EndPoint: POST /challenges/${id}/cancel, POST parameters: null, Status Code:null,
    Error: 'Failed to cancel challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to cancel challenge.');
  }
}

/**
 * adds assignee as challenge registrant
 * @param {Number} topcoderUserId the topcoder user id
 * @param {Object} challengeId the challenge id
 * @private
 */
async function assignUserAsRegistrant(topcoderUserId, challengeId) {
  // role 1 from registrant
  const registrantBody = {
    roleId: 1,
    resourceUserId: topcoderUserId,
    phaseId: 0,
    addNotification: true,
    addForumWatch: true
  };
  await addResourceToChallenge(challengeId, registrantBody);
}

/**
 * removes the resource from the topcoder challenge
 * @param {Number} id the challenge id
 * @param {Object} resource the resource resource to remove
 */
async function removeResourceToChallenge(id, resource) {
  bearer.apiKey = await getAccessToken();
  logger.debug(`removing resource from challenge ${id}`);
  try {
    const response = await new Promise((resolve, reject) => {
      challengesApiInstance.challengesIdResourcesDelete(id, resource, (err, res) => {
        if (err) {
          logger.error(circularJSON.stringify(err));
          reject(err);
        } else {
          logger.debug(`resource is removed from challenge ${id} successfully.`);
          resolve(res);
        }
      });
    });
    const statusCode = response.result ? response.result.status : null;
    loggerFile.info(`EndPoint: DELETE /challenges/${id}/resources,
    DELETE parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
  } catch (err) {
    loggerFile.info(`EndPoint: DELETE /challenges/${id}/resources, DELETE parameters: null, Status Code:null,
    Error: 'Failed to remove resource from the challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to remove resource from the challenge.');
  }
}

/**
 * gets resources from the topcoder challenge
 * @param {String} id the challenge id
 * @returns {Array} the resources of challenge
 */
async function getChallengeResources(id) {
  const apiKey = await getAccessToken();
  logger.debug(`getting resource from challenge ${id}`);
  try {
    const response = await axios.get(`${projectsClient.basePath}/challenges/${id}/resources`, {
      headers: {Authorization: `bearer ${apiKey}`}
    });
    const statusCode = response.data ? response.data.result.status : null;
    loggerFile.info(`EndPoint: GET /challenges/${id}/resources,
    GET parameters: null, Status Code:${statusCode}, Response:${circularJSON.stringify(response)}`);
    return _.get(response, 'data.result.content');
  } catch (err) {
    loggerFile.info(`EndPoint: GET /challenges/${id}/resources, GET parameters: null, Status Code:null,
    Error: 'Failed to get resource from the challenge.', Details: ${circularJSON.stringify(err)}`);
    throw errors.convertTopcoderApiError(err, 'Failed to get resource from the challenge.');
  }
}


module.exports = {
  createProject,
  getChallengeById,
  createChallenge,
  updateChallenge,
  activateChallenge,
  closeChallenge,
  getProjectBillingAccountId,
  getTopcoderMemberId,
  addResourceToChallenge,
  unregisterUserFromChallenge,
  cancelPrivateContent,
  assignUserAsRegistrant,
  removeResourceToChallenge,
  getChallengeResources
};
