// Copyright 2019-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const AWS = require('aws-sdk');
AWS.config.region = 'us-east-1';
const compression = require('compression');
const fs = require('fs');
const http = require('http');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
require('events').EventEmitter.prototype._maxListeners = Infinity;
const { metricScope } = require("aws-embedded-metrics");
let lock = false;
AWS.config.region = 'us-east-1';
const cloudWatch = new AWS.CloudWatch({
  apiVersion: '2010-08-01'
});
const cloudWatchClient = new AWS.CloudWatchLogs({
  apiVersion: '2014-03-28'
});
const s3 = new AWS.S3({
  apiVersion: '2006-03-01'
});

// Store created meetings in a map so attendees can join by meeting title
const meetingTable = {};

// Use local host for application server
const host = '127.0.0.1:8080';

// Load the contents of the web application to be used as the index page
const indexPage = fs.readFileSync(`dist/${process.env.npm_config_app || 'meetingV2'}.html`);

// Create ans AWS SDK Chime object. Region 'us-east-1' is currently required.
// Use the MediaRegion property below in CreateMeeting to select the region
// the meeting is hosted in.
const chime = new AWS.Chime({ region: 'us-east-1' });

// Set the AWS SDK Chime endpoint. The global endpoint is https://service.chime.aws.amazon.com.
// chime.endpoint = new AWS.Endpoint(process.env.ENDPOINT || 'https://service.chime.aws.amazon.com');
chime.endpoint = new AWS.Endpoint('https://tapioca.us-east-1.amazonaws.com');

// Start an HTTP server to serve the index page and handle meeting actions
http.createServer({}, async (request, response) => {
  log(`${request.method} ${request.url} BEGIN`);
  try {
    compression({})(request, response, () => {});
    const requestUrl = url.parse(request.url, true);
    let rBody = '';
    const logGroupName = 'ChimeBrowserLogs';
    const requestBody = await new Promise((resolve, reject) => {
      let requestBody = '';
      request.on('error', (err) => {
      }).on('data', (chunk) => {
        rBody = chunk.toString();
      }).on('end', () => {
        requestBody += rBody;
        resolve(requestBody);
      });
    });
    if (requestUrl.pathname === '/create_log_stream') {
      const body = JSON.parse(requestBody);
      if (!body.meetingId || !body.attendeeId) {
        throw new Error('Need parameters: meetingId, attendeeId');
      }
      const logStreamName = `ChimeSDKMeeting_${body.meetingId.toString()}_${body.attendeeId.toString()}`;
      console.log(logStreamName);
      await cloudWatchClient.createLogStream({
        logGroupName: logGroupName,
        logStreamName: logStreamName,
      }).promise();
    } else if (request.method === 'GET' && requestUrl.pathname === '/') {
      // Return the contents of the index page
      respond(response, 200, 'text/html', indexPage);
    } else if (process.env.DEBUG && request.method === 'POST' && requestUrl.pathname === '/join') {
      // For internal debugging - ignore this.
      respond(response, 201, 'application/json', JSON.stringify(require('./debug.js').debug(requestUrl.query), null, 2));
    } else if (requestUrl.pathname === '/get_load_test_status') {
      const getParams = {
        Bucket: 'chimesdkmeetingsloadtest',
        Key: 'src/configs/LoadTestStatus.json'
      };
      try {
        const data = await s3.getObject(getParams).promise();
        const loadTestStatus = data.Body.toString('utf-8');
        respond(response, 200, 'application/json', loadTestStatus);
      } catch (err) {
        console.error('Could not read status: ', err);
        respond(response, 400, 'application/json', JSON.stringify({}));
      }
    } else if (requestUrl.pathname === '/logs') {
      await logsEndpoint(logGroupName, requestBody, response);
    } else if (requestUrl.pathname === '/send_metrics') {
      const body = JSON.parse(requestBody);
      const meetingId = body.mId;
      const attendeeId = body.aId;
      const instanceId = body.iId;
      const startTime = body.ltStartTime;
      const sessionId = body.sId;
      if(body.hasOwnProperty('metricBody')) {
        const metricBody = body.metricBody;
        for (const [metricName, metricValue] of Object.entries(metricBody)) {
          console.log(`Emitting metric: ${metricName} : ` , metricValue);
          addToCloudWatchMetrics(meetingId, attendeeId, sessionId, instanceId, startTime, metricName, metricValue);
        }
      } else {
        const metricName = body.metricName;
        const metricValue = body.metricValue;
        addToCloudWatchMetrics(meetingId, attendeeId, sessionId, instanceId, startTime, metricName, metricValue);
        addStatusToCloudWatchMetrics(sessionId, instanceId, startTime, metricName, metricValue);
      }
      respond(response, 200, 'application/json', JSON.stringify({}));
    } else if (request.method === 'POST' && requestUrl.pathname === '/join') {
      if (!requestUrl.query.title || !requestUrl.query.name || !requestUrl.query.region) {
        throw new Error('Need parameters: title, name, region');
      }
      // Look up the meeting by its title. If it does not exist, create the meeting.
      if (!meetingTable[requestUrl.query.title]) {
        meetingTable[requestUrl.query.title] = await chime.createMeeting({
          // Use a UUID for the client request token to ensure that any request retries
          // do not create multiple meetings.
          ClientRequestToken: uuidv4(),
          // Specify the media region (where the meeting is hosted).
          // In this case, we use the region selected by the user.
          MediaRegion: requestUrl.query.region,
          // Any meeting ID you wish to associate with the meeting.
          // For simplicity here, we use the meeting title.
          ExternalMeetingId: requestUrl.query.title.substring(0, 64),
        }).promise();
      }

      // Fetch the meeting info
      const meeting = meetingTable[requestUrl.query.title];

      // Create new attendee for the meeting
      const attendee = await chime.createAttendee({
        // The meeting ID of the created meeting to add the attendee to
        MeetingId: meeting.Meeting.MeetingId,

        // Any user ID you wish to associate with the attendeee.
        // For simplicity here, we use a random id for uniqueness
        // combined with the name the user provided, which can later
        // be used to help build the roster.
        ExternalUserId: `${uuidv4().substring(0, 8)}#${requestUrl.query.name}`.substring(0, 64),
      }).promise()

      // Return the meeting and attendee responses. The client will use these
      // to join the meeting.
      respond(response, 201, 'application/json', JSON.stringify({
        JoinInfo: {
          Meeting: meeting,
          Attendee: attendee,
        },
      }, null, 2));
    } else if (request.method === 'POST' && requestUrl.pathname === '/end') {
      // End the meeting. All attendee connections will hang up.
      await chime.deleteMeeting({
        MeetingId: meetingTable[requestUrl.query.title].Meeting.MeetingId,
      }).promise();
      const cmd = `aws cloudwatch put-metric-data --metric-name 'DeleteMeeting' --dimensions Instance=\`curl http://169.254.169.254/latest/meta-data/instance-id\`  --namespace 'AlivePing' --value 1`;
      exec(cmd);
      respond(response, 200, 'application/json', JSON.stringify({}));
    } else {
      respond(response, 404, 'text/html', '404 Not Found');
    }
  } catch (err) {
    respond(response, 400, 'application/json', JSON.stringify({ error: err.message }, null, 2));
  }
  log(`${request.method} ${request.url} END`);
}).listen(host.split(':')[1], host.split(':')[0], () => {
  log(`server running at http://${host}/`);
});

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
};

function respond(response, statusCode, contentType, body) {
  try {
    if (lock === false) {
      lock = true;
      response.statusCode = statusCode;
      response.setHeader('Content-Type', contentType);
      response.end(body);
      if (contentType === 'application/json') {
        log(body);
      }
    }
  } catch (err) {
    console.log('respond failes with err:' + err);
  } finally {
    lock = false;
  }
}

function addToCloudWatchMetrics(meetingId, attendeeId, sessionId, instanceId, startTime, metricName, metricValue) {
  const putMetric =
    metricScope(metrics => async (meetingId, attendeeId, sessionId, instanceId, startTime, metricName, metricValue) => {
      console.log("received message");
      metrics.putDimensions({MId: meetingId, AId: attendeeId, SId: sessionId, IId: instanceId, StartTime: startTime.toLocaleString()});
      metrics.putMetric(metricName, metricValue);

      console.log("completed aggregation successfully.");
    });
  putMetric(meetingId, attendeeId, sessionId, instanceId, startTime, metricName, metricValue);
}

function addStatusToCloudWatchMetrics(sessionId, instanceId, startTime, metricName, metricValue) {
  const putMetric =
    metricScope(metrics => async (sessionId, instanceId, startTime, metricName, metricValue) => {
      console.log("received message");
      metrics.putDimensions({SId: sessionId, IId: instanceId, StartTime: startTime.toLocaleString()});
      metrics.putMetric(metricName, metricValue);

      console.log("completed aggregation successfully.");
    });
  putMetric(sessionId, instanceId, startTime, metricName, metricValue);
}

async function logsEndpoint(logGroupName, requestBody, response) {
  const body = JSON.parse(requestBody);
  const namespace = 'AlivePing';
  if (!body.logs || !body.meetingId || !body.attendeeId || !body.appName) {
    respond(response, 400, 'application/json', JSON.stringify({error: 'Need properties: logs, meetingId, attendeeId, appName'}));
  } else if (!body.logs.length) {
    respond(response, 200, 'application/json', JSON.stringify({}));
  }
  const logStreamName = `ChimeSDKMeeting_${body.meetingId.toString()}_${body.attendeeId.toString()}`;
  const putLogEventsInput = {
    logGroupName: logGroupName,
    logStreamName: logStreamName
  };
  const uploadSequence = await ensureLogStream(logStreamName, logGroupName);
  if (uploadSequence) {
    putLogEventsInput.sequenceToken = uploadSequence;
  }
  const logEvents = [];
  for (let i = 0; i < body.logs.length; i++) {
    const log = body.logs[i];
    const timestamp = new Date(log.timestampMs).toISOString();
    const message = `${timestamp} [${log.sequenceNumber}] [${log.logLevel}] [meeting: ${body.meetingId.toString()}] [attendee: ${body.attendeeId}]: ${log.message}`;
    logEvents.push({
      message: message,
      timestamp: log.timestampMs
    });
  }
  putLogEventsInput.logEvents = logEvents;
  try {
    await cloudWatchClient.putLogEvents(putLogEventsInput).promise();
  } catch (error) {
    const errorMessage = `Failed to put CloudWatch log events with error ${error} and params ${JSON.stringify(putLogEventsInput)}`;
    if (error.code === 'InvalidSequenceTokenException' || error.code === 'DataAlreadyAcceptedException') {
      console.warn(errorMessage);
    } else {
      console.error(errorMessage);
    }
  }
  respond(response, 200, 'application/json', JSON.stringify({}));
}

async function ensureLogStream(logStreamName, logGroupName) {
  const logStreamsResult = await cloudWatchClient.describeLogStreams({
    logGroupName: logGroupName,
    logStreamNamePrefix: logStreamName,
  }).promise();
  const foundStream = logStreamsResult.logStreams.find(s => s.logStreamName === logStreamName);
  if (foundStream) {
    return foundStream.uploadSequenceToken;
  }
  await cloudWatchClient.createLogStream({
    logGroupName: logGroupName,
    logStreamName: logStreamName,
  }).promise();
  return null;
}