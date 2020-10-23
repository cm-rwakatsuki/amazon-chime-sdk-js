// Copyright 2019-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const AWS = require('./aws-sdk');
const fs = require('fs');
const { v4: uuidv4 } = require('./uuid');
const cloudWatch = new AWS.CloudWatch({
  apiVersion: '2010-08-01'
});
const cloudWatchClient = new AWS.CloudWatchLogs({
  apiVersion: '2014-03-28'
});
const s3 = new AWS.S3({
  apiVersion: '2006-03-01'
});

// Store meetings in a DynamoDB table so attendees can join by meeting title
const ddb = new AWS.DynamoDB();

// Create an AWS SDK Chime object. Region 'us-east-1' is currently required.
// Use the MediaRegion property below in CreateMeeting to select the region
// the meeting is hosted in.
const chime = new AWS.Chime({ region: 'us-east-1' });

// Set the AWS SDK Chime endpoint. The global endpoint is https://service.chime.aws.amazon.com.
chime.endpoint = new AWS.Endpoint('https://tapioca.us-east-1.amazonaws.com');

// Read resource names from the environment
const meetingsTableName = process.env.MEETINGS_TABLE_NAME;
const logGroupName = process.env.BROWSER_LOG_GROUP_NAME;
const sqsQueueArn = process.env.SQS_QUEUE_ARN;
const useSqsInsteadOfEventBridge = process.env.USE_EVENT_BRIDGE === 'false';

// === Handlers ===

exports.index = async (event, context, callback) => {
  // Return the contents of the index page
  return response(200, 'text/html', fs.readFileSync('./index.html', {encoding: 'utf8'}));
};

exports.indexV2 = async (event, context, callback) => {
  // Return the contents of the index V2 page
  return response(200, 'text/html', fs.readFileSync('./indexV2.html', {encoding: 'utf8'}));
};

exports.join = async (event, context) => {
  const query = event.queryStringParameters;
  if (!query.title || !query.name || !query.region) {
    return response(400, 'application/json', JSON.stringify({error: 'Need parameters: title, name, region'}));
  }

  // Look up the meeting by its title. If it does not exist, create the meeting.
  let meeting = await getMeeting(query.title);
  if (!meeting) {
    const request = {
      // Use a UUID for the client request token to ensure that any request retries
      // do not create multiple meetings.
      ClientRequestToken: uuidv4(),

      // Specify the media region (where the meeting is hosted).
      // In this case, we use the region selected by the user.
      MediaRegion: query.region,

      // Set up SQS notifications if being used
      NotificationsConfiguration: useSqsInsteadOfEventBridge ? { SqsQueueArn: sqsQueueArn } : {},

      // Any meeting ID you wish to associate with the meeting.
      // For simplicity here, we use the meeting title.
      ExternalMeetingId: query.title.substring(0, 64),
    };
    console.info('Creating new meeting: ' + JSON.stringify(request));
    meeting = await chime.createMeeting(request).promise();

    // Store the meeting in the table using the meeting title as the key.
    await putMeeting(query.title, meeting);
  }

  // Create new attendee for the meeting
  console.info('Adding new attendee');
  const attendee = (await chime.createAttendee({
    // The meeting ID of the created meeting to add the attendee to
    MeetingId: meeting.Meeting.MeetingId,

    // Any user ID you wish to associate with the attendeee.
    // For simplicity here, we use a random UUID for uniqueness
    // combined with the name the user provided, which can later
    // be used to help build the roster.
    ExternalUserId: `${uuidv4().substring(0, 8)}#${query.name}`.substring(0, 64),
  }).promise());

  // Return the meeting and attendee responses. The client will use these
  // to join the meeting.
  return response(200, 'application/json', JSON.stringify({
    JoinInfo: {
      Meeting: meeting,
      Attendee: attendee,
    },
  }, null, 2));
};

exports.end = async (event, context) => {
  // Fetch the meeting by title
  const meeting = await getMeeting(event.queryStringParameters.title);

  // End the meeting. All attendee connections will hang up.
  await chime.deleteMeeting({ MeetingId: meeting.Meeting.MeetingId }).promise();
  return response(200, 'application/json', JSON.stringify({}));
};

exports.get_load_test_status = async (event, context) => {
  const getParams = {
    Bucket: 'chimesdkmeetingsloadtest',
    Key: 'src/configs/LoadTestStatus.json'
  };
  try {
    const data = await s3.getObject(getParams).promise();
    const loadTestStatus = data.Body.toString('utf-8');
    response(200, 'application/json', loadTestStatus);
  } catch(err) {
    console.error('Could not read status: ', err);
    response(400, 'application/json', JSON.stringify({}));
  }
  return response(400, 'application/json', JSON.stringify({}));
};

exports.logs = async (event, context) => {
  const body = JSON.parse(event.body);
  const namespace = 'AlivePing';
  if (!body.logs || !body.meetingId || !body.attendeeId || !body.appName) {
    response, 400, 'application/json', JSON.stringify({error: 'Need properties: logs, meetingId, attendeeId, appName'});
  } else if (!body.logs.length) {
    response, 200, 'application/json', JSON.stringify({});
  }
  const logStreamName = `ChimeSDKMeeting_${body.meetingId.toString()}_${body.attendeeId.toString()}`;
  const putLogEventsInput = {
    logGroupName: logGroupName,
    logStreamName: logStreamName
  };
  const uploadSequence = await ensureLogStream(logStreamName);
  if (uploadSequence) {
    putLogEventsInput.sequenceToken = uploadSequence;
  }
  const logEvents = [];
  for (let i = 0; i < body.logs.length; i++) {
    const log = body.logs[i];
    let isJSONString = false;
    let jsonLogMessage = null;
    try {
      if (log.message === null || log.message === '') {
        isJSONString = false;
      }
      jsonLogMessage = JSON.parse(log.message);
      isJSONString = (typeof jsonLogMessage === 'object');
    } catch (e) {
      isJSONString = false;
    }
    if (isJSONString && jsonLogMessage !== null) {
      const metricData = [];
      if ((jsonLogMessage.audioPacketsReceived && jsonLogMessage.audioPacketsReceived !== null)) {
        try {
          const metricDataLocal = putMetricData(jsonLogMessage, body.meetingId, body.attendeeId);
          for (let data = 0; data < metricDataLocal.length; data += 1) {
            metricData.push(metricDataLocal[data]);
          }
        } catch (err) {
          console.error('putMetricData error ', err);
        }
      } else {
        try {
          metricData.push(putMeetingStatusMetricData(jsonLogMessage));
        } catch (err) {
          console.error('putMeetingStatusMetricData error ', err);
        }
      }
      const params = {
        MetricData: metricData,
        Namespace: namespace
      };
      if (metricData.length > 0) {
        publishMetricToCloudWatch(params);
      }
      const timestamp = new Date(log.timestampMs).toISOString();
      const message = `${timestamp} [${log.sequenceNumber}] [${log.logLevel}] [meeting: ${body.meetingId.toString()}] [attendee: ${body.attendeeId}]: ${log.message}`;
      logEvents.push({
        message: message,
        timestamp: log.timestampMs
      });
    }
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
  return response(200, 'application/json', JSON.stringify({}));
};


exports.create_log_stream = async (event, context, callback) => {
  const body = JSON.parse(event.body);
  if (!body.meetingId || !body.attendeeId) {
    return response(400, 'application/json', JSON.stringify({error: 'Need properties: meetingId, attendeeId'}));
  }
  const logStreamName = `ChimeSDKMeeting_${body.meetingId.toString()}_${body.attendeeId.toString()}`;
  await cloudWatchClient.createLogStream({
    logGroupName: logGroupName,
    logStreamName: logStreamName,
  }).promise();
  return response(200, 'application/json', JSON.stringify({}));
}

// Called when SQS receives records of meeting events and logs out those records
exports.sqs_handler = async (event, context, callback) => {
  console.log(event.Records);
  return {};
}

// Called when EventBridge receives a meeting event and logs out the event
exports.event_bridge_handler = async (event, context, callback) => {
  console.log(event);
  return {};
}

// === Helpers ===

async function putMeetingStatusMetricData(messageJson) {
  const instanceId = String(messageJson.instanceId);
  let metricName = '';
  let metricValue = 0;
  if (messageJson.MeetingJoin !== undefined) {
    metricName = 'MeetingJoin';
    metricValue = messageJson[metricName];
  } else if (messageJson.MeetingLeave !== undefined) {
    metricName = 'MeetingLeave';
    metricValue = messageJson[metricName];
  } else if (messageJson.alivePing !== undefined) {
    metricName = 'alivePing';
    metricValue = messageJson[metricName];
  } else if (messageJson.PongReceived !== undefined) {
    metricName = 'PongReceived';
    metricValue = messageJson[metricName];
  } else if (messageJson.StatusCode !== undefined) {
    metricName = 'StatusCode-' + messageJson['StatusCode'];
    metricValue = 1;
  } else if (messageJson.MeetingStarted !== undefined) {
    metricName = 'MeetingStarted';
    metricValue = messageJson[metricName];
  } else if (messageJson.ReconnectingMeeting !== undefined) {
    metricName = 'ReconnectingMeeting';
    metricValue = messageJson[metricName];
  } else if (messageJson.ConnectingMeeting !== undefined) {
    metricName = 'ConnectingMeeting';
    metricValue = messageJson[metricName];
  }

  console.log(instanceId, `Emitting metric: ${metricName} --> ${metricValue} : `);
  return {
    MetricName: metricName,
    Dimensions: [{
      Name: 'Instance',
      Value: instanceId
    }],
    Timestamp: new Date().toISOString(),
    Value: metricValue
  };
}

async function putMetricData(messageJson, meetingId, attendeeId) {
  const instanceId = messageJson.instanceId;
  const loadTestStartTime = messageJson.loadTestStartTime;
  delete messageJson.instanceId;
  delete messageJson.loadTestStartTime;
  const dimensions = [
    {
      Name: 'MeetingId',
      Value: meetingId
    },
    {
      Name: 'AttendeeId',
      Value: attendeeId
    },
    {
      Name: 'Instance',
      Value: instanceId
    },
    {
      Name: 'LoadTestStartTime',
      Value: loadTestStartTime.toLocaleString()
    }
  ];
  delete messageJson.availableSendBandwidth;
  const metricData = [];
  for (const [metricName, metricValue] of Object.entries(messageJson)) {
    metricData.push({
      MetricName: metricName,
      Dimensions: dimensions,
      Timestamp: new Date().toISOString(),
      Value: metricValue
    });
  }
  return metricData;

}

async function publishMetricToCloudWatch(params) {
  try {
    let res = await cloudWatch.putMetricData(params).promise();
    if (res !== null) {
      console.log('putMetricData successful ', res);
    } else {
      console.log('putMetricData failed ', res);
    }
  } catch (error) {
    console.error(`Unable to emit metric: ${error}`)
  }
}

// Retrieves the meeting from the table by the meeting title
async function getMeeting(title) {
  const result = await ddb.getItem({
    TableName: meetingsTableName,
    Key: {
      'Title': {
        S: title
      },
    },
  }).promise();
  return result.Item ? JSON.parse(result.Item.Data.S) : null;
}

// Stores the meeting in the table using the meeting title as the key
async function putMeeting(title, meeting) {
  await ddb.putItem({
    TableName: meetingsTableName,
    Item: {
      'Title': { S: title },
      'Data': { S: JSON.stringify(meeting) },
      'TTL': {
        N: `${Math.floor(Date.now() / 1000) + 60 * 60 * 24}` // clean up meeting record one day from now
      }
    }
  }).promise();
}

// Creates log stream if necessary and returns the current sequence token
async function ensureLogStream(logStreamName) {
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

function response(statusCode, contentType, body) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': contentType },
    body: body,
    isBase64Encoded: false
  };
}
