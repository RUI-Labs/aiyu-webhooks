"use strict";

require('dotenv').config()
require('log-timestamp');

const MiniSearch = require('minisearch')
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const axios = require('axios');
const express = require("express")
const body_parser = require("body-parser")
const cors = require('cors')
const app = express().use(body_parser.json());
app.use(cors())

app.listen(process.env.PORT || 1337, () => console.log("webhook is listening"));

app.post("/messages", async (req, res) => {
  const {
    to,
    body,
  } = req.body
  await sendMessage(to, body)
  res.sendStatus(200)
})

app.post("/webhook", async (req, res) => {
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    if (req.body.entry[0].changes[0].value.messages) {
      return res.send("message missing").status(422)
    }
    const message = req.body.entry[0].changes[0].value.messages[0]
    const contact = req.body.entry[0].changes[0].value.contacts[0]
    const fromName = contact.profile.name
    const fromPhone = contact.wa_id
    const timestamp = parseInt(message.timestamp)
    let text = ''
    let caption = ''
    let imageUrl = ''
    let mediaId = ''
    let audioUrl = ''
    let extracteds = []
    switch (message.type) {
      case "text": {
        text = message.text.body;
        console.log("extracting text")
        const extracted = await extractText(text)
        console.log("extracted text")
        extracteds.push(extracted)
        break
      }
      case "image": {
        caption = message.image.caption;
        mediaId = message.image.id;
        try {
          console.log("retrieving", mediaId)
          imageUrl = await getMediaUrlFromId(mediaId)
          console.log("uploading", imageUrl)
          await upload(imageUrl, 'aiyuworld', `media/${mediaId}`)
          console.log("extracting", imageUrl)
          const arr = await extractImage(imageUrl)
          console.log("extracted", imageUrl)
          extracteds.push(...arr)
        } catch (err) {
          return res.send(err).status(422)
        }
        break
      }
      case "audio": {
        mediaId = message.audio.id;
        try {
          console.log("retriving", mediaId)
          audioUrl = await getMediaUrlFromId(mediaId)
          console.log("uploading", audioUrl)
          await upload(audioUrl, 'aiyuworld', `media/${mediaId}`)
          console.log("extracting", audioUrl)
          const extracted = await extractAudio(audioUrl)
          console.log("extracted", audioUrl)
          extracteds.push(extracted)
        } catch (err) {
          console.error(err)
          return res.send(err).status(422)
        }
        break
      }
    }
    const payloads = extracteds.map(o => {

      if (o.product.length > 0) {
        let totalPrice = 0
        o.product = o.product?.map(p => {
          const found = searchTitle(p.name)
          const subtotalPrice = p.quantity * found.price
          totalPrice += subtotalPrice
          return {
            ...p,
            key: found.id,
            fullName: found.fullName,
            zh_name: found.zh_name,
            en_name: found.en_name,
            unitPrice: found.price,
            subtotalPrice,
          }
        })
        o.totalPrice = totalPrice
        o.timestamp = Math.floor(new Date(`${o.date_year}.${o.date_month}.${o.date_day}`).getTime() / 1000)
      }
      return {
        driver: 'Bruce Lee',
        fromName: o.sender_name ? o.sender_name : fromName,
        fromPhone: o.sender_phone ? o.sender_phone : fromPhone,
        text,
        caption,
        imageUrl,
        audioUrl,
        mediaId,
        timestamp,
        extracted: o,
      }
    })
    await createOrder(payloads)
  }

  res.sendStatus(200);
});

app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;

  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === verify_token) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

async function getMediaUrlFromId(mediaId) {

  var config = {
    method: 'get',
    url: `https://graph.facebook.com/v15.0/${mediaId}`,
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
    }
  };

  return axios(config)
    .then(function(response) {
      return response.data.url
    })
    .catch(function(error) {
      console.log(error);
    });
}

function extractText(input) {
  var data = JSON.stringify({
    "id": "shaoye2",
    input
  });

  var config = {
    method: 'post',
    url: 'https://aiyu-parse-text.junyaoc.repl.co/',
    headers: {
      'Content-Type': 'application/json'
    },
    data: data
  };

  return axios(config)
    .then(function(response) {
      return response.data;
    })
    .catch(function(error) {
      console.error(error);
    });
}

function extractAudio(url) {

  var data = JSON.stringify({
    url
  });

  var config = {
    method: 'post',
    url: 'https://aiyu-whisper-fast.junyaoc.repl.co/',
    headers: {
      'Content-Type': 'application/json'
    },
    data: data
  };

  return axios(config)
    .then(function(response) {
      return response.data;
    })
    .catch(function(error) {
      console.error(error);
    });
}

function extractImage(url) {
  var data = JSON.stringify({
    url
  });

  var config = {
    method: 'post',
    url: 'https://ocr.shaoye.org/',
    headers: {
      'Content-Type': 'application/json'
    },
    data: data
  };

  return axios(config)
    .then(function(response) {
      return response.data;
    })
    .catch(function(error) {
      console.error(error);
    });
}

function createOrder(data) {
  var config = {
    method: 'post',
    url: 'https://api.shaoye.org/order',
    headers: {
      'Content-Type': 'application/json'
    },
    data
  };

  console.log(JSON.stringify(data))

  return axios(config)
    .catch(function(error) {
      console.log(error);
    });
}


function sendMessage(to, body) {
  return axios({
    method: "POST",
    url: `https://graph.facebook.com/v15.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
    data: {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN
    },
  }).then(resp => console.log(JSON.stringify(resp.data))).catch(err => {
    console.error(JSON.stringify(err))
  })
}

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET,
  },
  region: "ap-southeast-1",
});


async function upload(url, bucket, key) {

  const resp = await axios.get(url, {
    decompress: false,
    responseType: 'arraybuffer',
    headers: {
      'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN
    }
  }).catch(err => {
    throw err
  })

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: resp.data
  })

  await s3.send(command)
}

async function getProducts() {
  var config = {
    method: 'get',
    url: 'https://api.shaoye.org/product',
    headers: {
      'Content-Type': 'application/json'
    },
  };

  const products = await axios(config)
    .then(resp => {
      return resp.data.documents
    })
    .catch(function(error) {
      console.log(error);
    });

  return products
}


var miniSearch

function searchTitle(term) {
  const founds = miniSearch.search(term, { fuzzy: 0.2 })
  if (founds.length > 0) {
    return founds[0]
  } else {
    console.error(`${term} not found`)
  }
}

async function main() {
  const products = await getProducts()
  miniSearch = new MiniSearch({
    fields: ['zh_name', 'en_name', 'tag'],
    storeFields: ['fullName', 'zh_name', 'en_name', 'price']
  })
  miniSearch.addAll(products.map(o => ({ ...o.value, id: o.id })))
}

main()
