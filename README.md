# GoSpire

GoSpire is a modern application designed to enhance the rider experience by providing seamless navigation, exploration, and settlement features. Built with cutting-edge technologies, GoSpire ensures a user-friendly interface and robust functionality for riders and sponsors alike.

## Features

- **User Authentication**: Secure login and signup functionality.
- **Navigation and Exploration**: Discover new routes and explore destinations.
- **Settlement Management**: Simplified settlement processes for riders.
- **Notifications**: Real-time updates and alerts.

## Technologies Used

- **Frontend**: React Native with TypeScript
- **Backend**: Supabase for database and authentication
- **Services**: Location and Notification services
- **Payment Integration**: Payrex APIs and Webhooks (configured but not yet deployed in this testing version)

## Getting Started

Follow these steps to set up and run GoSpire on your local machine:

### Prerequisites

Ensure you have the following installed:

- Node.js (v16 or higher)
- npm or yarn
- Supabase CLI

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Akiri017/GoSpire.git
   ```

2. Navigate to the project directory:
   ```bash
   cd GoSpire/rider-app
   ```

3. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

4. Set up Supabase:
   - Create a Supabase project at [Supabase](https://supabase.com/).
   - Copy your Supabase credentials to `supabaseClient.js`.

5. Configure environment variables:
   - Add any required environment variables in a `.env` file.

### Running the Application

1. Start the development server:
   ```bash
   npx expo start --tunnel
   ```

2. Open the application on your mobile phone using the GoExpo app:
   - Download the GoExpo app from the [App Store](https://apps.apple.com) or [Google Play](https://play.google.com).
   - Scan the QR code displayed in the terminal to launch the app.

### Testing

Run the test suite to ensure everything is working:
```bash
npm test
```

## Folder Structure

- `app/`: Contains the main application screens and layouts.
- `components/`: Reusable UI components.
- `services/`: Location and notification services.
- `supabase/`: Supabase configuration and functions.
- `scripts/`: Utility scripts for project management.

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Submit a pull request with a detailed description of your changes.

## License

This project is licensed under the MIT License.

