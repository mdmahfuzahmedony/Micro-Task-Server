
const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors'); 

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB URI
const uri = "mongodb+srv://micro-task:JfnIEsZFzmdTCVIT@cluster0.awjlwox.mongodb.net/?appName=Cluster0";

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {

  try {
    // ডাটাবেস কানেক্ট করা
    await client.connect();
    
    // ডাটাবেস এবং কালেকশন তৈরি করা
    const db = client.db("micro-task"); 
    const myCollection = db.collection("tasks"); 










    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  }
}

// রান ফাংশন কল করা
run().catch(console.dir);

// রুট পাথ
app.get('/', (req, res) => {
  res.send('Server is running!')
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});